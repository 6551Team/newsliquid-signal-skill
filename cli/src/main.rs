use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::Value;
use sha2::Sha256;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const DEFAULT_BASE_URL: &str = "https://news-api.newsliquid.com";
const MAX_BODY_BYTES: usize = 2 << 20;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let input = read_input()?;
    let payload: Value = serde_json::from_slice(&input)
        .map_err(|error| format!("input must be a JSON NewsItem: {error}"))?;
    validate_payload(&payload)?;

    let app_id = required_env("SIGNAL_SOURCE_APP_ID")?;
    let app_secret = required_env("SIGNAL_SOURCE_APP_SECRET")?;
    let base_url = env::var("SIGNAL_SOURCE_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string();
    let body = serde_json::to_vec(&payload).map_err(|error| format!("cannot serialize input: {error}"))?;
    if body.len() > MAX_BODY_BYTES {
        return Err("request body exceeds 2 MiB".to_string());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is invalid: {error}"))?
        .as_secs()
        .to_string();
    let nonce = Uuid::new_v4().to_string();
    let mut mac = HmacSha256::new_from_slice(app_secret.as_bytes())
        .map_err(|_| "app secret cannot be used for HMAC".to_string())?;
    mac.update(timestamp.as_bytes());
    mac.update(b"\n");
    mac.update(nonce.as_bytes());
    mac.update(b"\n");
    mac.update(&body);
    let signature = hex::encode(mac.finalize().into_bytes());

    let url = format!(
        "{base_url}/api/v2/signal-sources/push/{}/events",
        urlencoding::encode(&app_id)
    );
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "x-signal-timestamp",
        HeaderValue::from_str(&timestamp).map_err(|error| format!("invalid timestamp header: {error}"))?,
    );
    headers.insert(
        "x-signal-nonce",
        HeaderValue::from_str(&nonce).map_err(|error| format!("invalid nonce header: {error}"))?,
    );
    headers.insert(
        "x-signal-signature",
        HeaderValue::from_str(&signature).map_err(|error| format!("invalid signature header: {error}"))?,
    );

    let response = reqwest::Client::new()
        .post(url)
        .timeout(Duration::from_secs(15))
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|error| format!("could not read response: {error}"))?;
    let document: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("server returned invalid JSON ({status}): {error}"))?;
    if !status.is_success() {
        let message = document
            .get("message")
            .or_else(|| document.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("request rejected");
        return Err(format!("server rejected request ({status}): {message}"));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&document).map_err(|error| format!("cannot print response: {error}"))?
    );
    Ok(())
}

fn read_input() -> Result<Vec<u8>, String> {
    let mut args = env::args().skip(1);
    let mut file = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("Usage: newsliquid-signal-cli [--file PATH]\n\nReads one NewsItem JSON object from stdin by default.");
                std::process::exit(0);
            }
            "--file" | "-f" => file = Some(args.next().ok_or("--file requires a path")?),
            value => return Err(format!("unknown argument: {value}; use --help")),
        }
    }
    if let Some(path) = file {
        fs::read(path).map_err(|error| format!("cannot read input file: {error}"))
    } else {
        let mut input = Vec::new();
        io::stdin()
            .read_to_end(&mut input)
            .map_err(|error| format!("cannot read stdin: {error}"))?;
        Ok(input)
    }
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

fn validate_payload(payload: &Value) -> Result<(), String> {
    let object = payload
        .as_object()
        .ok_or("input must be a JSON object")?;
    for field in ["text", "ts"] {
        let value = object
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        if value.is_none() {
            return Err(format!("{field} is required"));
        }
    }
    if let Some(id) = object.get("id") {
        if !id.is_string() || id.as_str().unwrap().as_bytes().len() > 256 {
            return Err("id must be a string of at most 256 characters".to_string());
        }
    }
    if let Some(score) = object.get("score") {
        let valid = score.as_i64().is_some_and(|value| (0..=100).contains(&value));
        if !valid {
            return Err("score must be an integer between 0 and 100".to_string());
        }
    }
    if let Some(tags) = object.get("tags") {
        if !tags.is_array() && !tags.is_object() {
            return Err("tags must be an object or array".to_string());
        }
    }
    Ok(())
}
