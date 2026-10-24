//! remote-exec 核心客户端和可选运维扩展共享的基础模块。

pub mod client;
pub mod commands;
pub mod config;
pub mod http;
pub mod smoke;
pub mod ui;

#[cfg(feature = "ops")]
pub mod bundle;
#[cfg(feature = "ops")]
pub mod deploy;
#[cfg(feature = "ops")]
pub mod migrate;
#[cfg(feature = "ops")]
pub mod prompt;
#[cfg(feature = "ops")]
pub mod upgrade;

pub fn output(text: &str) {
    use std::io::Write;
    let mut stderr = std::io::stderr().lock();
    let _ = write!(stderr, "{text}");
    let _ = stderr.flush();
}
