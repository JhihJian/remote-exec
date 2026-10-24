//! 运维扩展入口：部署、升级和迁移不进入核心 rex 客户端。

use remote_exec_rex::{config, deploy, migrate, upgrade};

const HELP: &str = "用法: rex-ops <命令> ...
  deploy   SSH 部署并登记主机
  upgrade  对已部署主机执行无中断升级
  migrate  将 Node 布局迁移到 Rust supervisor 布局";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("启动 tokio 运行时")
}

fn fail(message: &str) -> ! {
    eprintln!("\x1b[31m{message}\x1b[0m");
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(
        args.first().map(String::as_str),
        None | Some("-h" | "--help" | "help")
    ) {
        println!("{HELP}");
        return;
    }
    let store = config::Store::new(config::config_root());
    let Some(command) = args.first().map(String::as_str) else {
        println!("{HELP}");
        return;
    };
    let result = match command {
        "deploy" => runtime().block_on(deploy::run(&store, &args[1..])),
        "upgrade" => runtime().block_on(upgrade::run(&store, &args[1..])),
        "migrate" => runtime().block_on(migrate::run(&store, &args[1..])),
        other => fail(&format!("未知运维命令: {other}\n{HELP}")),
    };
    match result {
        Ok(code) if code != 0 => std::process::exit(code),
        Ok(_) => {}
        Err(error) => fail(&error),
    }
}
