use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use clap::Parser;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal;
use tokio_util::io::ReaderStream;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use teleimg_mtproto_bridge::{
    BRIDGE_ROUTE_PATH, BridgeSettings, DEFAULT_BIND, PreparedDownload, SignedDownloadQuery,
    TelegramBridge, bridge_route_path, encode_content_disposition_file_name, verify_signed_query,
};

#[derive(Debug, Parser)]
#[command(name = "teleimg-mtproto-bridge")]
#[command(about = "Serve signed Telegram MTProto downloads for TeleImg")]
struct Args {
    #[arg(long, env = "TG_MT_BRIDGE_BIND", default_value = DEFAULT_BIND)]
    bind: SocketAddr,

    #[arg(long, env = "TG_MT_BRIDGE_SECRET")]
    secret: String,

    #[arg(long, env = "TG_USER_API_ID")]
    api_id: i32,

    #[arg(
        long,
        env = "TG_USER_SESSION_FILE",
        default_value = "./teleimg-user.session"
    )]
    session_file: PathBuf,

    #[arg(long, env = "TG_MT_BRIDGE_TMP_DIR")]
    temp_dir: Option<PathBuf>,

    #[arg(long, env = "RUST_LOG", default_value = "info")]
    log_filter: String,
}

#[derive(Clone)]
struct AppState {
    bridge: TelegramBridge,
    secret: String,
    temp_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    init_tracing(&args.log_filter)?;

    let bridge = TelegramBridge::connect(&BridgeSettings {
        api_id: args.api_id,
        session_file: args.session_file.clone(),
    })
    .await?;

    let state = AppState {
        bridge,
        secret: args.secret,
        temp_dir: args.temp_dir,
    };

    let app = Router::new()
        .route(BRIDGE_ROUTE_PATH, get(download_handler))
        .route("/healthz", get(healthz_handler))
        .with_state(state);

    let listener = TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("failed to bind {}", args.bind))?;

    info!(bind = %args.bind, route = bridge_route_path(), "teleimg rust mtproto bridge listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("axum server failed")?;

    Ok(())
}

async fn download_handler(
    State(state): State<AppState>,
    Query(query): Query<SignedDownloadQuery>,
) -> impl IntoResponse {
    if let Err(error) = verify_signed_query(&state.secret, &query) {
        let message = error.to_string();
        let status = if message.contains("expired") {
            StatusCode::GONE
        } else if message.contains("signature") {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::BAD_REQUEST
        };
        return text_response(status, &message);
    }

    match state
        .bridge
        .prepare_download(&query, state.temp_dir.as_deref())
        .await
    {
        Ok(prepared) => stream_response(prepared),
        Err(error) => {
            error!(?error, chat_id = %query.chat_id, message_id = %query.message_id, "failed to prepare MTProto download");
            text_response(StatusCode::BAD_GATEWAY, &error.to_string())
        }
    }
}

async fn healthz_handler(State(state): State<AppState>) -> impl IntoResponse {
    let authorized = state.bridge.client().is_authorized().await.unwrap_or(false);
    let status = if authorized {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status,
        Json(json!({
            "ok": authorized,
            "route": bridge_route_path(),
            "authorized": authorized,
        })),
    )
}

fn stream_response(prepared: PreparedDownload) -> Response<Body> {
    let mut response = Response::new(Body::from_stream(ReaderStream::new(prepared.file)));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&prepared.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    if let Ok(length) = HeaderValue::from_str(&prepared.content_length.to_string()) {
        headers.insert(CONTENT_LENGTH, length);
    }
    if let Ok(disposition) =
        HeaderValue::from_str(&encode_content_disposition_file_name(&prepared.file_name))
    {
        headers.insert(CONTENT_DISPOSITION, disposition);
    }
    response
}

fn text_response(status: StatusCode, message: &str) -> Response<Body> {
    let mut response = Response::new(Body::from(message.to_owned()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn init_tracing(filter: &str) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(filter).unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .without_time()
        .try_init()
        .map_err(|error| anyhow::anyhow!("failed to initialize tracing subscriber: {error}"))?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = signal::ctrl_c().await {
            error!(?error, "failed to listen for ctrl-c");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => {
                error!(?error, "failed to listen for SIGTERM");
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
