//! rex：remote-exec 核心客户端入口。

use remote_exec_rex::commands;
use remote_exec_rex::config::{self, Store};
use remote_exec_rex::ui;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("启动 tokio 运行时")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let store = Store::new(config::config_root());
    let result = match args.first() {
        None => runtime().block_on(ui::run(&store, None)),
        Some(_) => runtime().block_on(commands::run(&store, &args)),
    };
    if let Err(error) = result {
        fail(&error);
    }
}

fn fail(message: &str) -> ! {
    eprintln!("\x1b[31m{message}\x1b[0m");
    std::process::exit(1);
}
