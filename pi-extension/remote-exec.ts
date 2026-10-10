/**
 * remote-exec：远程主机工具（pi extension）
 *
 * 把 remote-exec WSS daemon 接入 pi，提供模型可调用工具：
 *   remote_bash(host, command)   在远程主机执行 shell 命令
 *   remote_read(host, file)      读远程文件
 *   remote_write(host, file)     写远程文件
 *
 * 主机清单来自本机配置 ~/.config/remote-exec/hosts.json，并通过 before_agent_start
 * 注入系统提示词，让模型知道有哪些主机及使用规则。
 *
 * 客户端为零依赖手写实现（pi 的虚拟模块环境没有 ws），与 daemon 协议一一对应，
 * 协议行为参考仓库中的 test-client.js。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

// ---------- 配置 ----------

const CONFIG_PATH = path.join(os.homedir(), ".config", "remote-exec", "hosts.json");

interface HostConfig {
	host: string;
	port: number;
	servername?: string;
	ca: string;
	tokenFile: string;
	cwd?: string;
	note?: string;
	via?: string; // 经由哪台网关主机转发（该主机需运行 relay 版 daemon）
}

interface RemoteExecConfig {
	hosts: Record<string, HostConfig>;
}

function loadConfig(): RemoteExecConfig | null {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as RemoteExecConfig;
		if (!raw?.hosts || Object.keys(raw.hosts).length === 0) return null;
		return raw;
	} catch {
		return null;
	}
}

/** 工具注册发生在模块加载时，schema 里的主机枚举取自当时的配置快照 */
const initialConfig = loadConfig();
const HOST_NAMES = initialConfig ? Object.keys(initialConfig.hosts) : [];

// ---------- WSS 客户端（零依赖：tls + RFC 6455 帧 + JSON 消息配对） ----------

const CONNECT_TIMEOUT_MS = 10_000;
const READ_MAX_BYTES = 100 * 1024; // remote_read 返回给模型的内容上限

function encodeFrame(str: string): Buffer {
	const payload = Buffer.from(str, "utf8");
	const mask = crypto.randomBytes(4);
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.alloc(2);
		header[1] = 0x80 | payload.length;
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4);
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	header[0] = 0x81;
	const masked = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
	return Buffer.concat([header, mask, masked]);
}

interface WssCallResult {
	exitCode: number;
	stdoutB64: string;
	stderrB64: string;
	truncated?: boolean;
}

interface RemoteFileResult {
	contentB64: string;
	size: number;
}

class WssClient {
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private fragments: { opcode: number; chunks: Buffer[] } | null = null;
	private nextId = 1;
	private socket: tls.TLSSocket | null = null;

	constructor(
		private opts: { host: string; port: number; servername?: string; ca: string; token: string },
	) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const key = crypto.randomBytes(16).toString("base64");
			const socket = tls.connect({
				host: this.opts.host,
				port: this.opts.port,
				servername: this.opts.servername || this.opts.host,
				ca: fs.readFileSync(this.opts.ca),
				rejectUnauthorized: true,
			});
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`连接 ${this.opts.host}:${this.opts.port} 超时`));
			}, CONNECT_TIMEOUT_MS);
			socket.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			socket.on("secureConnect", () => {
				socket.write(
					`GET / HTTP/1.1\r\nHost: ${this.opts.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
						`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
						`Authorization: Bearer ${this.opts.token}\r\n\r\n`,
				);
			});
			socket.on("data", (chunk) => {
				this.buffer = Buffer.concat([this.buffer, chunk]);
				if (!this.upgraded) {
					const idx = this.buffer.indexOf("\r\n\r\n");
					if (idx < 0) return;
					const head = this.buffer.subarray(0, idx).toString();
					if (!/HTTP\/1\.1 101/.test(head)) {
						clearTimeout(timer);
						socket.destroy();
						const status = head.split("\r\n")[0];
						reject(
							status.includes("401")
								? new Error("认证失败：token 与服务端 token.sha256 不匹配")
								: new Error(`WebSocket 升级被拒绝: ${status}`),
						);
						return;
					}
					this.upgraded = true;
					this.buffer = this.buffer.subarray(idx + 4);
					this.socket = socket;
					clearTimeout(timer);
					resolve();
				}
				this.consumeFrames();
			});
		});
	}

	private upgraded = false;

	private consumeFrames(): void {
		for (;;) {
			const buf = this.buffer;
			if (buf.length < 2) return;
			const fin = (buf[0] & 0x80) !== 0;
			const opcode = buf[0] & 0x0f;
			const masked = (buf[1] & 0x80) !== 0;
			if (masked) throw new Error("服务端帧不应 mask");
			const lenBits = buf[1] & 0x7f;
			let offset = 2;
			let length: number;
			if (lenBits < 126) length = lenBits;
			else if (lenBits === 126) {
				if (buf.length < 4) return;
				length = buf.readUInt16BE(2);
				offset = 4;
			} else {
				if (buf.length < 10) return;
				length = Number(buf.readBigUInt64BE(2));
				offset = 10;
			}
			if (buf.length < offset + length) return;
			const payload = buf.subarray(offset, offset + length);
			this.buffer = buf.subarray(offset + length);

			if (opcode === 0x9) {
				// ping 自动回 pong
				this.socket?.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
				continue;
			}
			if (opcode === 0x8) {
				this.socket?.end();
				return;
			}
			if (opcode === 0x1 || opcode === 0x2) {
				if (!fin) {
					this.fragments = { opcode, chunks: [payload] };
					continue;
				}
				this.dispatch(payload);
				continue;
			}
			if (opcode === 0x0 && this.fragments) {
				this.fragments.chunks.push(payload);
				if (fin) {
					const full = Buffer.concat(this.fragments.chunks);
					this.fragments = null;
					this.dispatch(full);
				}
			}
		}
	}

	private dispatch(payload: Buffer): void {
		let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
		try {
			msg = JSON.parse(payload.toString("utf8"));
		} catch {
			return;
		}
		if (typeof msg.id !== "number") return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		if (msg.error) p.reject(new Error(`rpc ${msg.error.code}: ${msg.error.message}`));
		else p.resolve(msg.result);
	}

	call<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.socket?.write(encodeFrame(JSON.stringify({ id, method, params })));
		});
	}

	close(): void {
		this.socket?.end();
	}
}

/** 每次工具调用建立一个短连接（与 codex-remote-run 同模式，简单可靠）。
 * 目标带 via 时经网关 relay 转发：凭证（目标 token/CA）随请求携带，网关不存储。 */
async function callHost<T>(hostName: string, method: string, params: Record<string, unknown>): Promise<T> {
	const config = loadConfig();
	const hosts = config?.hosts;
	const host = hosts?.[hostName];
	if (!host) {
		const available = hosts ? Object.keys(hosts).join(", ") : "（配置不存在或为空）";
		throw new Error(`未知主机 "${hostName}"，可用主机: ${available}`);
	}
	const targetToken = fs.readFileSync(host.tokenFile, "utf8").trim();

	// 直连模式
	if (!host.via) {
		const client = new WssClient({
			host: host.host,
			port: host.port,
			servername: host.servername,
			ca: host.ca,
			token: targetToken,
		});
		try {
			await client.connect();
			return await client.call<T>(method, params);
		} finally {
			client.close();
		}
	}

	// relay 模式：连接网关，把真实请求包进 relay 方法
	const gateway = hosts[host.via];
	if (!gateway) throw new Error(`主机 "${hostName}" 的 via 网关 "${host.via}" 不在配置中`);
	if (gateway.via) throw new Error(`via 链深度仅支持 1（${hostName} -> ${host.via} -> ...），不支持链式转发`);
	const gatewayToken = fs.readFileSync(gateway.tokenFile, "utf8").trim();
	const client = new WssClient({
		host: gateway.host,
		port: gateway.port,
		servername: gateway.servername,
		ca: gateway.ca,
		token: gatewayToken,
	});
	try {
		await client.connect();
		const envelope = await client.call<{ relayed: boolean; result: T | null; error: { code: number; message: string } | null }>("relay", {
			target: { host: host.host, port: host.port },
			auth: { token: targetToken, ca: fs.readFileSync(host.ca, "utf8") },
			request: { method, params },
		});
		if (envelope.error) throw new Error(`目标返回错误 rpc ${envelope.error.code}: ${envelope.error.message}`);
		return envelope.result as T;
	} finally {
		client.close();
	}
}

/** 流式上传大文件：HTTP 端点，内存 O(1)，sha256 双向校验 */
function httpUpload(host: HostConfig, token: string, localFile: string, remoteFile: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(localFile);
		} catch (err) {
			reject(new Error(`本地文件不可读: ${localFile} (${err instanceof Error ? err.message : String(err)})`));
			return;
		}
		const localHash = crypto.createHash("sha256");
		const t0 = Date.now();
		const req = tls.connect(
			{ host: host.host, port: host.port, servername: host.servername || host.host, ca: fs.readFileSync(host.ca), rejectUnauthorized: true },
			() => {
				req.write(
					`POST /upload?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\n` +
						`Authorization: Bearer ${token}\r\nContent-Length: ${stat.size}\r\nConnection: close\r\n\r\n`,
				);
				// 不发 TLS fin：fin 与服务端未消费数据竞态会判 aborted，收完响应后再 end
				fs.createReadStream(localFile)
					.on("data", (c) => localHash.update(c))
					.pipe(req, { end: false });
			},
		);
		let raw = Buffer.alloc(0);
		req.on("data", (c) => (raw = Buffer.concat([raw, c])));
		req.on("end", () => {
			req.end();
			const idx = raw.indexOf("\r\n\r\n");
			const head = raw.subarray(0, idx).toString();
			const body = raw.subarray(idx + 4).toString();
			if (!/ 200 /.test(head.split("\r\n")[0])) {
				reject(new Error(`上传失败: ${head.split("\r\n")[0]} ${body}`));
				return;
			}
			const result = JSON.parse(body) as { size: number; sha256: string };
			if (result.sha256 !== localHash.digest("hex")) {
				reject(new Error(`sha256 校验不一致，远端文件可能损坏，建议重传`));
				return;
			}
			const seconds = (Date.now() - t0) / 1000;
			resolve(`已上传 ${localFile} -> ${host.host}:${remoteFile}（${result.size} 字节，${(result.size / 1024 / 1024 / seconds).toFixed(1)} MB/s，sha256 校验一致）`);
		});
		req.on("error", reject);
	});
}

/** 流式下载大文件：HTTP 端点，内存 O(1)，sha256 校验 */
function httpDownload(host: HostConfig, token: string, remoteFile: string, localFile: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		fs.mkdirSync(path.dirname(localFile), { recursive: true });
		const out = fs.createWriteStream(localFile);
		const t0 = Date.now();
		const req = tls.connect(
			{ host: host.host, port: host.port, servername: host.servername || host.host, ca: fs.readFileSync(host.ca), rejectUnauthorized: true },
			() => {
				req.write(
					`GET /download?path=${encodeURIComponent(remoteFile)} HTTP/1.1\r\nHost: h\r\n` +
						`Authorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
				);
			},
		);
		let headerBuf = Buffer.alloc(0);
		let headerDone = false;
		let bytes = 0;
		const fail = (msg: string) => {
			out.destroy();
			fs.unlink(localFile, () => {});
			reject(new Error(msg));
		};
		req.on("data", (c: Buffer) => {
			if (!headerDone) {
				headerBuf = Buffer.concat([headerBuf, c]);
				const idx = headerBuf.indexOf("\r\n\r\n");
				if (idx < 0) return;
				const status = headerBuf.subarray(0, idx).toString().split("\r\n")[0];
				if (!/ 200 /.test(status)) {
						req.destroy();
						fail(`下载失败: ${status}`);
						return;
				}
				headerDone = true;
				const first = headerBuf.subarray(idx + 4);
				if (first.length) {
						hash.update(first);
						out.write(first);
						bytes += first.length;
				}
				return;
			}
			hash.update(c);
			out.write(c);
			bytes += c.length;
		});
		req.on("end", () => {
			out.end(() => {
				const seconds = (Date.now() - t0) / 1000;
				resolve(`已下载 ${host.host}:${remoteFile} -> ${localFile}（${bytes} 字节，${(bytes / 1024 / 1024 / seconds).toFixed(1)} MB/s，sha256 ${hash.digest("hex").slice(0, 16)}…）`);
			});
		});
		req.on("error", (err) => fail(String(err)));
	});
}

function resolveHost(hostName: string): { host: HostConfig; token: string } {
	const config = loadConfig();
	const host = config?.hosts[hostName];
	if (!host) {
		const available = config ? Object.keys(config.hosts).join(", ") : "（配置不存在或为空）";
		throw new Error(`未知主机 "${hostName}"，可用主机: ${available}`);
	}
	const token = fs.readFileSync(host.tokenFile, "utf8").trim();
	return { host, token };
}

// ---------- 工具实现 ----------

function unknownHostResult(err: unknown): string {
	return `远程执行失败：${err instanceof Error ? err.message : String(err)}`;
}

async function remoteBash(host: string, command: string, cwd?: string, timeoutMs?: number): Promise<string> {
	try {
		const r = await callHost<WssCallResult>(host, "exec", {
			command,
			cwd: cwd || undefined,
			timeoutMs: timeoutMs || undefined,
		});
		const stdout = Buffer.from(r.stdoutB64, "base64").toString("utf8");
		const stderr = Buffer.from(r.stderrB64, "base64").toString("utf8");
		const parts = [`[exit ${r.exitCode}]`];
		if (stdout) parts.push(stdout.replace(/\n$/, ""));
		if (stderr) parts.push(`[stderr]\n${stderr.replace(/\n$/, "")}`);
		if (r.truncated) parts.push("[输出超过上限被截断，可用更精确的命令或调大 outputBytesCap]");
		return parts.join("\n");
	} catch (err) {
		return unknownHostResult(err);
	}
}

async function remoteRead(host: string, file: string): Promise<string> {
	try {
		const r = await callHost<RemoteFileResult>(host, "file.read", { file });
		const content = Buffer.from(r.contentB64, "base64");
		if (content.length > READ_MAX_BYTES) {
			return `${file}（${r.size} 字节）超过 ${READ_MAX_BYTES} 字节上限，前 100KB 如下，其余请用 remote_bash + sed/awk 分段读取：\n\n${content
				.subarray(0, READ_MAX_BYTES)
				.toString("utf8")}`;
		}
		return content.toString("utf8");
	} catch (err) {
		return unknownHostResult(err);
	}
}

async function remoteWrite(host: string, file: string, content: string): Promise<string> {
	try {
		const r = await callHost<{ size: number }>(host, "file.write", {
			file,
			contentB64: Buffer.from(content, "utf8").toString("base64"),
		});
		return `已写入 ${file}（${r.size} 字节）`;
	} catch (err) {
		return unknownHostResult(err);
	}
}

// ---------- extension 注册 ----------

export default function remoteExecExtension(pi: ExtensionAPI): void {
	if (HOST_NAMES.length === 0) {
		// 配置缺失时不注册工具，避免模型看到不可用的工具
		return;
	}

	const hostEnum = Type.Union(HOST_NAMES.map((name) => Type.Literal(name)));

	pi.registerTool({
		name: "remote_bash",
		label: `Remote Bash (${HOST_NAMES.join("/")})`,
		description: "在配置的远程主机上执行 shell 命令（bash -lc）。主机清单见系统提示词。",
		promptSnippet: "Execute shell commands on configured remote hosts.",
		promptGuidelines: [
			"需要在远程主机上执行命令时使用 remote_bash，host 取提示词中列出的主机名。",
			"远程操作优先用 remote_read / remote_write 读写文件，remote_bash 处理其余命令。",
		],
		parameters: Type.Object({
			host: Type.String({ description: "目标主机名（见系统提示词主机清单）" }),
			command: Type.String({ description: "要执行的 shell 命令" }),
			cwd: Type.Optional(Type.String({ description: "工作目录（绝对路径，可选）" })),
			timeoutMs: Type.Optional(Type.Number({ description: "超时毫秒数，默认 5 分钟" })),
		}),
		async execute(_id, params) {
			const text = await remoteBash(params.host, params.command, params.cwd, params.timeoutMs);
			return { content: [{ type: "text", text }], details: { host: params.host } };
		},
	});

	pi.registerTool({
		name: "remote_read",
		label: `Remote Read (${HOST_NAMES.join("/")})`,
		description: "读取远程主机上的文件内容（UTF-8 文本）。",
		promptSnippet: "Read files on configured remote hosts.",
		parameters: Type.Object({
			host: Type.String({ description: "目标主机名（见系统提示词主机清单）" }),
			file: Type.String({ description: "远程文件绝对路径" }),
		}),
		async execute(_id, params) {
			const text = await remoteRead(params.host, params.file);
			return { content: [{ type: "text", text }], details: { host: params.host, file: params.file } };
		},
	});

	pi.registerTool({
		name: "remote_write",
		label: `Remote Write (${HOST_NAMES.join("/")})`,
		description: "向远程主机写入文件（UTF-8 文本，自动创建父目录）。",
		promptSnippet: "Write files on configured remote hosts.",
		parameters: Type.Object({
			host: Type.String({ description: "目标主机名（见系统提示词主机清单）" }),
			file: Type.String({ description: "远程文件绝对路径" }),
			content: Type.String({ description: "要写入的完整内容（UTF-8）" }),
		}),
		async execute(_id, params) {
			const text = await remoteWrite(params.host, params.file, params.content);
			return { content: [{ type: "text", text }], details: { host: params.host, file: params.file } };
		},
	});

	// 大文件传输工具（HTTP 流式端点，不经过 LLM 上下文）
	pi.registerTool({
		name: "remote_upload",
		label: `Remote Upload (${HOST_NAMES.join("/")})`,
		description: "把本机大文件流式上传到远程主机（sha256 校验，内存 O(1)，适合 GB 级文件）。",
		promptSnippet: "Upload large local files to remote hosts.",
		parameters: Type.Object({
			host: Type.String({ description: "目标主机名（见系统提示词主机清单）" }),
			localFile: Type.String({ description: "本机文件绝对路径" }),
			remoteFile: Type.String({ description: "远程目标绝对路径（已存在则覆盖）" }),
		}),
		async execute(_id, params) {
			const { host, token } = resolveHost(params.host);
			if (host.via) throw new Error(`"${params.host}" 经网关 "${host.via}" 中转，暂不支持流式上传。可先上传到网关再由网关转存，或用 ssh -L 临时隧道`);
			const text = await httpUpload(host, token, params.localFile, params.remoteFile);
			return { content: [{ type: "text", text }], details: { host: params.host, remoteFile: params.remoteFile } };
		},
	});

	pi.registerTool({
		name: "remote_download",
		label: `Remote Download (${HOST_NAMES.join("/")})`,
		description: "把远程主机的大文件流式下载到本机（sha256 校验，内存 O(1)，适合 GB 级文件）。",
		promptSnippet: "Download large remote files to local machine.",
		parameters: Type.Object({
			host: Type.String({ description: "目标主机名（见系统提示词主机清单）" }),
			remoteFile: Type.String({ description: "远程文件绝对路径" }),
			localFile: Type.String({ description: "本机目标绝对路径（已存在则覆盖）" }),
		}),
		async execute(_id, params) {
			const { host, token } = resolveHost(params.host);
			if (host.via) throw new Error(`"${params.host}" 经网关 "${host.via}" 中转，暂不支持流式下载。可先下载到网关再从网关拉取，或用 ssh -L 临时隧道`);
			const text = await httpDownload(host, token, params.remoteFile, params.localFile);
			return { content: [{ type: "text", text }], details: { host: params.host, remoteFile: params.remoteFile } };
		},
	});

	// 主机清单注入系统提示词（提示词注入方式，模型据此选择 host 参数）
	pi.on("before_agent_start", async (event) => {
		const config = loadConfig();
		if (!config) return;
		const hasRemoteTools = event.systemPromptOptions?.selectedTools?.some((t) => t.startsWith("remote_"));
		if (!hasRemoteTools) return;
		const lines = Object.entries(config.hosts).map(([name, h]) => {
			const cwdInfo = h.cwd ? `，默认目录 ${h.cwd}` : "";
			const note = h.note ? `：${h.note}` : "";
			const viaInfo = h.via ? `，经网关 ${h.via} 转发` : "";
			return `- ${name}（${h.host}:${h.port}${cwdInfo}${viaInfo}）${note}`;
		});
		const section = `

## 远程主机工具（remote-exec）

通过 remote_bash / remote_read / remote_write 在远程主机上执行命令和读写文件。
主机清单（配置文件 ${CONFIG_PATH}）：
${lines.join("\n")}

使用规则：
- host 参数只能取上述主机名
- 远程路径必须是绝对路径
- 命令在远程 bash -lc 下执行，不支持交互式输入
- 读写文件优先用 remote_read / remote_write，其余操作用 remote_bash
- 大文件（部署包、备份、数据集等）传输用 remote_upload / remote_download，不走 base64 通道；标注"经网关转发"的主机暂不支持流式传输
`;
		return { systemPrompt: `${event.systemPrompt}${section}` };
	});
}
