---
name: 远程执行链路无中断升级
description: 适用于需要先验证备用 generation、执行连接排空并保留可回滚路径的远程 daemon 升级。
---

```mermaid
flowchart TD
  start((开始)) --> baseline[确认运行基线]
  baseline -->|基线完整| bootstrap[判断单入口 bootstrap]
  baseline -->|基线缺失| finish((结束))
  bootstrap -->|入口已预部署| parallel{{并行}}
  bootstrap -->|首次安装需受控切换| finish
  parallel --> xiaomi[验证测试环境]
  parallel --> package[验证候选版本]
  xiaomi -->|已执行| merge[汇总测试结果]
  package -->|已执行| merge
  merge -->|已执行| drain[执行连接排空演练]
  drain -->|通过| canary[逐节点灰度切换]
  drain -->|失败| rollback[回滚新连接路由]
  rollback -->|已恢复| drain
  canary -->|稳定| finish
  canary -->|异常| rollback
```

## 确认运行基线

```新建Agent
只读检查当前 remote-exec 的运行版本、端口 owner、启动方式、证书和 token 文件位置、客户端入口、活动连接以及可用回滚材料。确认 xiaomi 可作为隔离测试环境。不要修改文件、启动服务或重启服务。
任务：
{outcome}
```

### 基线完整

已确认运行边界、回滚材料和测试环境，可以开始并行验证。

### 基线缺失

存在会影响升级安全性的未确认事实，停止流程并补齐基线。

## 判断单入口 bootstrap

```新建Agent
确认目标设备只有现有 remote-exec 入口时的升级前提：入口所有者是否已经预部署并持有固定端口，daemon generation 是否只使用本机回环端口，是否存在本地控制或父子进程交接能力，以及首次安装是否需要一次受控断连。若入口尚未预部署且业务要求首次安装零断连，明确当前系统无法满足并停止流程。若接受受控 bootstrap，记录维护窗口和回滚材料。
输入：
{outcome}
```

### 入口已预部署

稳定入口已经接管固定端口，可以进入 xiaomi 和候选版本的并行验证。

### 首次安装需受控切换

当前系统尚未具备单入口热升级基础能力，实施前需要确认一次受控断连窗口。

## 验证测试环境

```执行自定义命令
{
  "command": "node",
  "args": ["-e", "console.log('测试环境验证由实施者按设计文档执行')"],
  "stdin": {"task": "{outcome}"}
}
```

### 已执行

测试环境使用独立固定入口、独立回环 generation 端口、独立凭据和可回滚材料，不依赖目标设备具备 SSH 或额外外部端口。

## 验证候选版本

```执行自定义命令
{
  "command": "npm",
  "args": ["test"],
  "stdin": {"task": "{outcome}"}
}
```

### 已执行

候选版本通过本地语法、类型、协议、relay 和进程组清理测试。

## 汇总测试结果

```执行自定义命令
{
  "command": "node",
  "args": ["-e", "console.log('根据分支结果执行隔离环境放行判断')"],
  "stdin": {
    "xiaomi": {xiaomi.outcome},
    "package": {package.outcome}
  }
}
```

### 已执行

候选版本和隔离环境均满足演练前置条件。

## 执行连接排空演练

```新建Agent
在不影响正式入口的前提下，启动候选 generation，保持直连流式命令、relay 流式命令和文件传输，切换新连接路由，然后让旧 generation drain。记录活动连接、终态响应、输出顺序、子进程组和旧 generation 退出状态。必要时只在测试环境回滚。
输入：
{outcome}
```

### 通过

既有连接完整排空，新连接进入候选 generation，旧 generation 可在活动归零后退出。

### 失败

排空或回滚证据不足，返回重新执行测试环境和候选版本验证。

## 逐节点灰度切换

```新建Agent
按 xiaomi、NM105、nm108 的顺序灰度升级。目标设备只使用现有外部入口，generation 运行在本机回环端口。入口切换只影响新连接，旧 generation 继续 drain。NM105 与 nm108 不同时切换。任一门禁失败立即把新连接路由回旧 generation。
输入：
{outcome}
```

### 稳定

所有节点完成观察窗口，旧版本和回滚路径仍可用。

### 异常

新版本或链路出现异常，执行回滚并保留诊断材料。

## 回滚新连接路由

```新建Agent
停止向新 generation 分配新连接，把新连接路由回旧 generation，保留旧版本及其配置，确认旧入口的 healthz、readyz、真实 exec 和 relay 均恢复。不要删除新版本日志，不要自动重试状态未知的非幂等请求。
输入：
{outcome}
```

### 已恢复

旧 generation 已恢复服务，保留失败证据并回到连接排空演练。
