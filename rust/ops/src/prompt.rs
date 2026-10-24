//! 交互提示：指纹确认与密码输入（无回显）。
//! 非 TTY 环境明确报错，避免脚本场景挂起或密码泄漏进管道。
use std::io::{BufRead, IsTerminal, Write};

pub fn confirm(prompt: &str) -> Result<bool, String> {
    if !std::io::stdin().is_terminal() {
        return Err(format!(
            "{prompt}（非交互环境无法确认，请使用 --host-key 传入指纹）"
        ));
    }
    let mut stderr = std::io::stderr().lock();
    let _ = write!(stderr, "{prompt} [y/N] ");
    let _ = stderr.flush();
    let mut line = String::new();
    let mut stdin = std::io::stdin().lock();
    stdin
        .read_line(&mut line)
        .map_err(|e| format!("读取确认输入失败: {e}"))?;
    let answer = line.trim().to_ascii_lowercase();
    Ok(answer == "y" || answer == "yes")
}

pub fn secret(prompt: &str) -> Result<String, String> {
    if !std::io::stdin().is_terminal() {
        return Err(format!(
            "{prompt}（非交互环境无法输入密码，请配置 SSH 密钥或 --identity）"
        ));
    }
    rpassword::prompt_password(format!("{prompt}: ")).map_err(|e| format!("读取密码输入失败: {e}"))
}
