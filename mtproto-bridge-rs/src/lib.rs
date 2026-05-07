use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use grammers_client::message::InputMessage;
use grammers_client::media::Media;
use grammers_client::{Client, SignInError};
use grammers_mtsender::SenderPool;
use grammers_session::Session;
use grammers_session::storages::SqliteSession;
use grammers_session::types::{PeerId, PeerRef};
use hmac::{Hmac, KeyInit, Mac};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use sha2::Sha256;
use tempfile::{Builder as TempFileBuilder, NamedTempFile};
use tokio::fs::File;
use tokio::sync::RwLock;
use tracing::{info, warn};

pub const BRIDGE_ROUTE_PATH: &str = "/telegram/file";
pub const DEFAULT_BIND: &str = "127.0.0.1:8788";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Deserialize)]
pub struct SignedDownloadQuery {
    #[serde(rename = "chatId")]
    pub chat_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub key: String,
    pub name: String,
    pub expires: String,
    #[serde(rename = "sig")]
    pub signature: String,
}

#[derive(Debug, Clone)]
pub struct BridgeSettings {
    pub api_id: i32,
    pub session_file: PathBuf,
}

#[derive(Debug)]
pub struct PreparedDownload {
    pub file: File,
    pub content_type: String,
    pub content_length: u64,
    pub file_name: String,
}

#[derive(Debug, Clone)]
pub struct UploadedMessage {
    pub chat_id: i64,
    pub message_id: i32,
    pub file_name: String,
}

#[derive(Clone)]
pub struct TelegramBridge {
    client: Client,
    session: Arc<SqliteSession>,
    peer_cache: Arc<RwLock<HashMap<i64, PeerRef>>>,
}

impl SignedDownloadQuery {
    pub fn validate(&self) -> Result<()> {
        for (field, value) in [
            ("chatId", self.chat_id.as_str()),
            ("messageId", self.message_id.as_str()),
            ("key", self.key.as_str()),
            ("name", self.name.as_str()),
            ("expires", self.expires.as_str()),
            ("sig", self.signature.as_str()),
        ] {
            if value.trim().is_empty() {
                bail!("missing {field}");
            }
        }

        self.chat_id_i64()?;
        self.message_id_i32()?;
        self.expires_unix()?;
        Ok(())
    }

    pub fn chat_id_i64(&self) -> Result<i64> {
        self.chat_id
            .trim()
            .parse::<i64>()
            .with_context(|| format!("invalid chat id {}", self.chat_id))
    }

    pub fn message_id_i32(&self) -> Result<i32> {
        let value = self
            .message_id
            .trim()
            .parse::<i32>()
            .with_context(|| format!("invalid message id {}", self.message_id))?;
        if value <= 0 {
            bail!("message id must be positive");
        }
        Ok(value)
    }

    pub fn expires_unix(&self) -> Result<u64> {
        let value = self
            .expires
            .trim()
            .parse::<u64>()
            .with_context(|| format!("invalid expires {}", self.expires))?;
        if value == 0 {
            bail!("expires must be positive");
        }
        Ok(value)
    }

    pub fn is_expired(&self) -> Result<bool> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("system clock is before unix epoch")?
            .as_secs();
        Ok(now > self.expires_unix()?)
    }

    pub fn payload_string(&self) -> String {
        [
            self.chat_id.trim(),
            self.message_id.trim(),
            self.key.trim(),
            self.name.trim(),
            self.expires.trim(),
        ]
        .join("\n")
    }

    pub fn sanitized_file_name(&self) -> String {
        sanitize_download_name(&self.name, &self.key)
    }
}

impl TelegramBridge {
    pub async fn connect(settings: &BridgeSettings) -> Result<Self> {
        let session = Arc::new(
            SqliteSession::open(&settings.session_file)
                .await
                .with_context(|| {
                    format!(
                        "failed to open session file {}",
                        settings.session_file.display()
                    )
                })?,
        );

        let SenderPool { runner, handle, .. } =
            SenderPool::new(Arc::clone(&session), settings.api_id);
        tokio::spawn(async move {
            runner.run().await;
            warn!("grammers sender pool exited");
        });

        let client = Client::new(handle);
        if !client
            .is_authorized()
            .await
            .context("failed to query telegram authorization state")?
        {
            bail!(
                "telegram session {} is not authorized; run teleimg-mtproto-login first",
                settings.session_file.display()
            );
        }

        info!(session_file = %settings.session_file.display(), "telegram bridge session ready");

        Ok(Self {
            client,
            session,
            peer_cache: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub async fn prepare_download(
        &self,
        query: &SignedDownloadQuery,
        temp_dir: Option<&Path>,
    ) -> Result<PreparedDownload> {
        let peer = self.resolve_peer_ref(query.chat_id_i64()?).await?;
        let message_id = query.message_id_i32()?;
        let messages = self
            .client
            .get_messages_by_id(peer, &[message_id])
            .await
            .context("failed to fetch telegram message by id")?;
        let message = messages.into_iter().next().flatten().ok_or_else(|| {
            anyhow!(
                "telegram message {} not found in chat {}",
                message_id,
                query.chat_id
            )
        })?;
        let media = message
            .media()
            .ok_or_else(|| anyhow!("telegram message {} has no downloadable media", message_id))?;

        let temp_file = create_temp_file(temp_dir).context("failed to allocate temporary file")?;
        self.client
            .download_media(&media, temp_file.path())
            .await
            .context("failed to download telegram media")?;

        let file_name = choose_file_name(&media, &query.sanitized_file_name(), &query.key);
        let content_type = choose_content_type(&media, &file_name);
        let file = temp_file
            .reopen()
            .context("failed to reopen downloaded temporary file")?;
        let content_length = file
            .metadata()
            .context("failed to stat downloaded temporary file")?
            .len();
        drop(temp_file);

        Ok(PreparedDownload {
            file: File::from_std(file),
            content_type,
            content_length,
            file_name,
        })
    }

    pub async fn upload_stream_to_chat<S: tokio::io::AsyncRead + Unpin>(
        &self,
        chat_id: i64,
        stream: &mut S,
        size: usize,
        file_name: &str,
        content_type: Option<&str>,
    ) -> Result<UploadedMessage> {
        let peer = self.resolve_peer_ref(chat_id).await?;
        let safe_file_name = sanitize_download_name(file_name, "upload.bin");
        let uploaded = self
            .client
            .upload_stream(stream, size, safe_file_name.clone())
            .await
            .context("failed to upload media stream to telegram")?;

        let mut input = InputMessage::new().text("").file(uploaded);
        if let Some(mime) = content_type.map(str::trim).filter(|value| !value.is_empty()) {
            input = input.mime_type(mime);
        }

        let message = self
            .client
            .send_message(peer, input)
            .await
            .context("failed to send uploaded media message")?;

        Ok(UploadedMessage {
            chat_id: message.peer_id().bot_api_dialog_id(),
            message_id: message.id(),
            file_name: safe_file_name,
        })
    }

    async fn resolve_peer_ref(&self, chat_id: i64) -> Result<PeerRef> {
        if let Some(peer) = self.peer_cache.read().await.get(&chat_id).copied() {
            return Ok(peer);
        }

        if let Some(peer_id) = peer_id_from_bot_dialog_id(chat_id)
            && let Some(peer) = self
                .session
                .peer(peer_id)
                .await
                .and_then(peer_ref_from_peer_info)
        {
            self.peer_cache.write().await.insert(chat_id, peer);
            return Ok(peer);
        }

        let mut dialogs = self.client.iter_dialogs();
        while let Some(dialog) = dialogs
            .next()
            .await
            .context("failed to iterate telegram dialogs")?
        {
            let peer = dialog.peer();
            let dialog_id = peer.id().bot_api_dialog_id();
            if let Some(peer_ref) = peer.to_ref().await {
                self.peer_cache.write().await.insert(dialog_id, peer_ref);
                if dialog_id == chat_id {
                    return Ok(peer_ref);
                }
            }
        }

        bail!(
            "telegram session cannot resolve chat {}; make sure this user account can access that dialog",
            chat_id
        )
    }
}

pub async fn login_to_session(
    api_id: i32,
    api_hash: &str,
    session_file: impl AsRef<Path>,
    phone_number: Option<&str>,
) -> Result<String> {
    let session_path = session_file.as_ref();
    let session = Arc::new(
        SqliteSession::open(session_path)
            .await
            .with_context(|| format!("failed to open session file {}", session_path.display()))?,
    );
    let SenderPool { runner, handle, .. } = SenderPool::new(Arc::clone(&session), api_id);
    tokio::spawn(async move {
        runner.run().await;
        warn!("grammers sender pool exited during login");
    });

    let client = Client::new(handle);
    if !client
        .is_authorized()
        .await
        .context("failed to check telegram authorization state")?
    {
        info!(session_file = %session_path.display(), "signing in telegram user session");
        let phone = match phone_number {
            Some(phone) if !phone.trim().is_empty() => phone.trim().to_owned(),
            _ => prompt_line("Telegram phone number (international format): ")?,
        };
        let token = client
            .request_login_code(&phone, api_hash)
            .await
            .context("failed to request telegram login code")?;
        let code = prompt_line("Telegram login code: ")?;
        match client.sign_in(&token, code.trim()).await {
            Ok(_) => {}
            Err(SignInError::PasswordRequired(password_token)) => {
                let hint = password_token.hint().unwrap_or("unknown");
                let password =
                    rpassword::prompt_password(format!("Telegram 2FA password (hint {hint}): "))?;
                client
                    .check_password(password_token, password.trim())
                    .await
                    .context("telegram 2FA password check failed")?;
            }
            Err(error) => return Err(anyhow!(error).context("telegram sign-in failed")),
        }
    }

    let me = client
        .get_me()
        .await
        .context("failed to fetch telegram self user")?;
    let display_name = me.first_name().unwrap_or("Telegram user").to_owned();
    let username = me.username().unwrap_or("").to_owned();
    let line = if username.is_empty() {
        format!("authorized {display_name} into {}", session_path.display())
    } else {
        format!(
            "authorized {display_name} (@{username}) into {}",
            session_path.display()
        )
    };
    Ok(line)
}

pub fn bridge_route_path() -> &'static str {
    BRIDGE_ROUTE_PATH
}

pub fn verify_signed_query(secret: &str, query: &SignedDownloadQuery) -> Result<()> {
    query.validate()?;
    if query.is_expired()? {
        bail!("signed download URL has expired");
    }

    let signature = URL_SAFE_NO_PAD
        .decode(query.signature.trim())
        .context("invalid base64url signature")?;
    let mut mac = HmacSha256::new_from_slice(secret.trim().as_bytes())
        .map_err(|_| anyhow!("failed to initialize HMAC"))?;
    mac.update(query.payload_string().as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| anyhow!("invalid signed download signature"))
}

pub fn sanitize_download_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    let replaced = trimmed.replace(['\r', '\n'], " ").replace(['/', '\\'], "-");
    let collapsed = replaced.trim();
    if collapsed.is_empty() {
        fallback.trim().to_owned()
    } else {
        collapsed.chars().take(240).collect()
    }
}

pub fn encode_content_disposition_file_name(name: &str) -> String {
    format!(
        "inline; filename*=UTF-8''{}",
        utf8_percent_encode(name, NON_ALPHANUMERIC)
    )
}

pub fn create_temp_file(temp_dir: Option<&Path>) -> Result<NamedTempFile> {
    let mut builder = TempFileBuilder::new();
    builder.prefix("teleimg-");
    let file = match temp_dir {
        Some(dir) => builder.tempfile_in(dir),
        None => builder.tempfile(),
    }?;
    Ok(file)
}

pub fn choose_file_name(media: &Media, requested_name: &str, fallback_key: &str) -> String {
    let fallback = sanitize_download_name(requested_name, fallback_key);
    match media {
        Media::Document(document) => {
            sanitize_download_name(document.name().unwrap_or(&fallback), &fallback)
        }
        Media::Photo(_) => fallback,
        Media::Sticker(sticker) => {
            sanitize_download_name(sticker.document.name().unwrap_or(&fallback), &fallback)
        }
        _ => fallback,
    }
}

pub fn choose_content_type(media: &Media, file_name: &str) -> String {
    match media {
        Media::Photo(_) => "image/jpeg".to_owned(),
        Media::Document(document) => document
            .mime_type()
            .map(ToOwned::to_owned)
            .or_else(|| {
                mime_guess::from_path(file_name)
                    .first_raw()
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| "application/octet-stream".to_owned()),
        Media::Sticker(sticker) => sticker
            .document
            .mime_type()
            .map(ToOwned::to_owned)
            .or_else(|| {
                mime_guess::from_path(file_name)
                    .first_raw()
                    .map(ToOwned::to_owned)
            })
            .unwrap_or_else(|| "application/octet-stream".to_owned()),
        _ => mime_guess::from_path(file_name)
            .first_raw()
            .unwrap_or("application/octet-stream")
            .to_owned(),
    }
}

pub fn peer_id_from_bot_dialog_id(dialog_id: i64) -> Option<PeerId> {
    if dialog_id > 0 {
        PeerId::user(dialog_id)
    } else if dialog_id <= -1000000000001 {
        PeerId::channel((-dialog_id) - 1_000_000_000_000)
    } else if dialog_id < 0 {
        PeerId::chat(-dialog_id)
    } else {
        None
    }
}

fn peer_ref_from_peer_info(peer: grammers_session::types::PeerInfo) -> Option<PeerRef> {
    peer.auth().map(|auth| PeerRef {
        id: peer.id(),
        auth,
    })
}

pub fn prompt_line(prompt: &str) -> Result<String> {
    use std::io::{self, BufRead, Write};

    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    stdout.write_all(prompt.as_bytes())?;
    stdout.flush()?;

    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let mut line = String::new();
    stdin.read_line(&mut line)?;
    Ok(line.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_matches_js_reference() {
        let query = SignedDownloadQuery {
            chat_id: "-10001".into(),
            message_id: "35".into(),
            key: "abc.mp4".into(),
            name: "Demo Video.mp4".into(),
            expires: "4102444800".into(),
            signature: "psKnme4pZqXAZNGdtYZlj0-7JZTgvQKPwcjmWnDCA1Q".into(),
        };

        verify_signed_query("secret", &query).unwrap();
        assert_eq!(
            query.payload_string(),
            "-10001\n35\nabc.mp4\nDemo Video.mp4\n4102444800"
        );
    }

    #[test]
    fn dialog_id_conversion_matches_bot_format() {
        assert_eq!(
            peer_id_from_bot_dialog_id(42).unwrap().bot_api_dialog_id(),
            42
        );
        assert_eq!(
            peer_id_from_bot_dialog_id(-99).unwrap().bot_api_dialog_id(),
            -99
        );
        assert_eq!(
            peer_id_from_bot_dialog_id(-1001234567890)
                .unwrap()
                .bot_api_dialog_id(),
            -1001234567890
        );
    }

    #[test]
    fn sanitize_name_removes_path_separators() {
        assert_eq!(
            sanitize_download_name(" ../demo/video.mp4 ", "fallback.bin"),
            "..-demo-video.mp4"
        );
        assert_eq!(sanitize_download_name("", "fallback.bin"), "fallback.bin");
    }
}
