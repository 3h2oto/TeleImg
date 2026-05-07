use std::net::SocketAddr;
use std::path::PathBuf;
use std::{io, str::FromStr};

use anyhow::{Context, Result};
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use clap::Parser;
use futures_util::TryStreamExt;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::signal;
use tokio_util::io::{ReaderStream, StreamReader};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use teleimg_mtproto_bridge::{
    BRIDGE_ROUTE_PATH, BridgeSettings, DEFAULT_BIND, PreparedDownload, SignedDownloadQuery,
    TelegramBridge, UploadedMessage, bridge_route_path, encode_content_disposition_file_name,
    sanitize_download_name, verify_signed_query,
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
        .route("/telegram/upload", post(upload_handler))
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
            "uploadRoute": "/telegram/upload",
            "authorized": authorized,
        })),
    )
}

async fn upload_handler(State(state): State<AppState>, request: Request) -> impl IntoResponse {
    let (parts, body) = request.into_parts();
    match parse_upload_request(&state, &parts.headers) {
        Ok(upload) => {
            let data_stream = body
                .into_data_stream()
                .map_err(|error| io::Error::other(format!("request body stream failed: {error}")));
            let mut reader = StreamReader::new(data_stream);

            match state
                .bridge
                .upload_stream_to_chat(
                    upload.chat_id,
                    &mut reader,
                    upload.content_length,
                    &upload.file_name,
                    upload.content_type.as_deref(),
                )
                .await
            {
                Ok(message) => upload_json_response(message, upload.content_length, upload.content_type),
                Err(error) => {
                    error!(?error, chat_id = upload.chat_id, file_name = %upload.file_name, "failed to upload MTProto media");
                    text_response(StatusCode::BAD_GATEWAY, &error.to_string())
                }
            }
        }
        Err((status, message)) => text_response(status, &message),
    }
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

struct UploadRequestMeta {
    chat_id: i64,
    file_name: String,
    content_length: usize,
    content_type: Option<String>,
}

fn parse_upload_request(
    state: &AppState,
    headers: &HeaderMap,
) -> std::result::Result<UploadRequestMeta, (StatusCode, String)> {
    let secret = header_value(headers, "x-teleimg-bridge-secret").unwrap_or_default();
    if secret != state.secret {
        return Err((StatusCode::FORBIDDEN, "Invalid bridge upload secret.".to_owned()));
    }

    let chat_id = header_value(headers, "x-teleimg-chat-id")
        .and_then(|value| i64::from_str(&value).ok())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "Missing or invalid x-teleimg-chat-id.".to_owned()))?;

    let content_length = header_value(headers, CONTENT_LENGTH.as_str())
        .or_else(|| header_value(headers, "x-teleimg-file-size"))
        .and_then(|value| usize::from_str(&value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| (StatusCode::LENGTH_REQUIRED, "Valid content-length is required.".to_owned()))?;

    let raw_name = header_value(headers, "x-teleimg-file-name").unwrap_or_else(|| "upload.bin".to_owned());
    let decoded_name = percent_encoding::percent_decode_str(&raw_name)
        .decode_utf8()
        .map(|value| value.into_owned())
        .unwrap_or(raw_name);

    Ok(UploadRequestMeta {
        chat_id,
        file_name: sanitize_download_name(&decoded_name, "upload.bin"),
        content_length,
        content_type: header_value(headers, CONTENT_TYPE.as_str()).filter(|value| !value.trim().is_empty()),
    })
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_owned())
}

fn upload_json_response(
    message: UploadedMessage,
    content_length: usize,
    content_type: Option<String>,
) -> Response<Body> {
    let body = json!({
        "ok": true,
        "upload": {
            "chatId": message.chat_id.to_string(),
            "messageId": message.message_id,
            "fileName": message.file_name,
            "fileSize": content_length,
            "contentType": content_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
            "mediaKind": "document",
        }
    });

    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = StatusCode::CREATED;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
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
