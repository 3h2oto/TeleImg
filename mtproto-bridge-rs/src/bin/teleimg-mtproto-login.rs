use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tracing_subscriber::EnvFilter;

use teleimg_mtproto_bridge::login_to_session;

#[derive(Debug, Parser)]
#[command(name = "teleimg-mtproto-login")]
#[command(about = "Authorize a Telegram user session for the TeleImg Rust MTProto bridge")]
struct Args {
    #[arg(long, env = "TG_USER_API_ID")]
    api_id: i32,

    #[arg(long, env = "TG_USER_API_HASH")]
    api_hash: String,

    #[arg(
        long,
        env = "TG_USER_SESSION_FILE",
        default_value = "./teleimg-user.session"
    )]
    session_file: PathBuf,

    #[arg(long, env = "TG_USER_PHONE")]
    phone: Option<String>,

    #[arg(long, env = "RUST_LOG", default_value = "info")]
    log_filter: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_new(&args.log_filter).unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .without_time()
        .try_init()
        .ok();

    let summary = login_to_session(
        args.api_id,
        args.api_hash.trim(),
        &args.session_file,
        args.phone.as_deref(),
    )
    .await?;

    println!("{summary}");
    Ok(())
}
