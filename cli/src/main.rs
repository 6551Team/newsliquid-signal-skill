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

#[derive(Clone, Copy, Debug, PartialEq)]
enum Operation {
    Push,
    Update,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let (operation, test, input) = read_input()?;
    let mut payload: Value = serde_json::from_slice(&input)
        .map_err(|error| format!("input must be a JSON object: {error}"))?;
    if operation == Operation::Push {
        validate_payload(&payload)?;
        if test {
            payload["test"] = Value::Bool(true);
        }
    } else if !payload.is_object() {
        return Err("source configuration must be a JSON object".to_string());
    }

    let app_id = required_env("SIGNAL_SOURCE_APP_ID")?;
    let app_secret = required_env("SIGNAL_SOURCE_APP_SECRET")?;
    let base_url = env::var("SIGNAL_SOURCE_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string();
    let body =
        serde_json::to_vec(&payload).map_err(|error| format!("cannot serialize input: {error}"))?;
    if body.len() > MAX_BODY_BYTES {
        return Err("request body exceeds 2 MiB".to_string());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is invalid: {error}"))?
        .as_secs()
        .to_string();
    let nonce = Uuid::new_v4().to_string();
    let signature = sign_request(operation, &app_secret, &timestamp, &nonce, &body)?;

    let app = urlencoding::encode(&app_id);
    let path = match operation {
        Operation::Push => format!("/api/v2/signal-sources/push/{app}/events"),
        Operation::Update => format!("/api/v2/signal-sources/apps/{app}"),
    };
    let url = format!("{base_url}{path}");
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "x-signal-timestamp",
        HeaderValue::from_str(&timestamp)
            .map_err(|error| format!("invalid timestamp header: {error}"))?,
    );
    headers.insert(
        "x-signal-nonce",
        HeaderValue::from_str(&nonce).map_err(|error| format!("invalid nonce header: {error}"))?,
    );
    headers.insert(
        "x-signal-signature",
        HeaderValue::from_str(&signature)
            .map_err(|error| format!("invalid signature header: {error}"))?,
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
        serde_json::to_string_pretty(&document)
            .map_err(|error| format!("cannot print response: {error}"))?
    );
    Ok(())
}

fn parse_args(
    args: impl Iterator<Item = String>,
) -> Result<(Operation, bool, Option<String>), String> {
    let mut args = args.peekable();
    let operation = match args.peek().map(String::as_str) {
        Some("update") => {
            args.next();
            Operation::Update
        }
        Some("push") => {
            args.next();
            Operation::Push
        }
        _ => Operation::Push,
    };
    let mut file = None;
    let mut test = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("Usage: newsliquid-signal-cli [push|update] [--file PATH] [--test]\n\nReads one JSON object from stdin by default.\n  push    Send a NewsItem (default)\n  update  Edit the signal source bound to the credentials\n  --test  Save a push in source history without strategy delivery");
                std::process::exit(0);
            }
            "--file" | "-f" => file = Some(args.next().ok_or("--file requires a path")?),
            "--test" => test = true,
            value => return Err(format!("unknown argument: {value}; use --help")),
        }
    }
    if test && operation != Operation::Push {
        return Err("--test is only supported for push".to_string());
    }
    Ok((operation, test, file))
}

fn read_input() -> Result<(Operation, bool, Vec<u8>), String> {
    let (operation, test, file) = parse_args(env::args().skip(1))?;
    let input = if let Some(path) = file {
        fs::read(path).map_err(|error| format!("cannot read input file: {error}"))?
    } else {
        let mut input = Vec::new();
        io::stdin()
            .read_to_end(&mut input)
            .map_err(|error| format!("cannot read stdin: {error}"))?;
        input
    };
    Ok((operation, test, input))
}

fn sign_request(
    operation: Operation,
    secret: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| "app secret cannot be used for HMAC".to_string())?;
    mac.update(timestamp.as_bytes());
    mac.update(b"\n");
    mac.update(nonce.as_bytes());
    mac.update(b"\n");
    if operation == Operation::Update {
        mac.update(b"signal-source:update\n");
    }
    mac.update(body);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

fn validate_payload(payload: &Value) -> Result<(), String> {
    let object = payload.as_object().ok_or("input must be a JSON object")?;
    if object.get("test").is_some_and(|test| !test.is_boolean()) {
        return Err("test must be a boolean".to_string());
    }
    if let Some(meta) = object.get("meta") {
        if !meta.is_object() {
            return Err("meta must be an object".to_string());
        }
    }
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
        let valid = score
            .as_i64()
            .is_some_and(|value| (0..=100).contains(&value));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_keep_legacy_push_usage() {
        for (args, expected_operation, expected_file) in [
            (vec![], Operation::Push, None),
            (
                vec!["--file", "signal.json"],
                Operation::Push,
                Some("signal.json"),
            ),
            (
                vec!["push", "-f", "signal.json"],
                Operation::Push,
                Some("signal.json"),
            ),
            (vec!["update"], Operation::Update, None),
            (
                vec!["update", "--file", "source.json"],
                Operation::Update,
                Some("source.json"),
            ),
        ] {
            let (operation, test, file) = parse_args(args.into_iter().map(String::from)).unwrap();
            assert_eq!(operation, expected_operation);
            assert!(!test);
            assert_eq!(file.as_deref(), expected_file);
        }
        assert!(parse_args(vec!["update", "--file"].into_iter().map(String::from)).is_err());
        assert!(parse_args(vec!["delete"].into_iter().map(String::from)).is_err());
    }

    #[test]
    fn test_push_flag_does_not_apply_to_updates() {
        for args in [
            vec!["--test"],
            vec!["push", "--test"],
            vec!["push", "--file", "signal.json", "--test"],
        ] {
            let (operation, test, _) = parse_args(args.into_iter().map(String::from)).unwrap();
            assert_eq!(operation, Operation::Push);
            assert!(test);
        }
        assert!(parse_args(vec!["update", "--test"].into_iter().map(String::from)).is_err());
        let payload =
            serde_json::json!({"text": "signal", "ts": "2026-10-12T08:00:00Z", "test": true});
        assert!(validate_payload(&payload).is_ok());
        assert!(validate_payload(
            &serde_json::json!({"text": "signal", "ts": "now", "test": "true"})
        )
        .is_err());
    }

    #[test]
    fn signing_matches_sdk_vectors_and_separates_operations() {
        let body = br#"{"description":"Updated"}"#;
        assert_eq!(
            sign_request(Operation::Push, "secret", "1720000000", "nonce-1", body).unwrap(),
            "1381aae456eb26e27979d81adf0d4a50fde341229bd27fc674c314c39c612167"
        );
        assert_eq!(
            sign_request(Operation::Update, "secret", "1720000000", "nonce-1", body).unwrap(),
            "7d331450e2b0a2ceac8835426e67ec3dbf01a9b46d7dfdce686deaf6f03af590"
        );
    }

    #[test]
    fn meta_is_preserved_and_must_be_an_object() {
        let payload = serde_json::json!({"text": "signal", "ts": "2026-10-10T08:00:00Z", "meta": {"chain": "solana", "amount": 2500, "buy": false}});
        assert!(validate_payload(&payload).is_ok());
        assert_eq!(
            serde_json::from_slice::<Value>(&serde_json::to_vec(&payload).unwrap()).unwrap()
                ["meta"],
            payload["meta"]
        );
        assert!(
            validate_payload(&serde_json::json!({"text": "signal", "ts": "now", "meta": []}))
                .is_err()
        );
    }
}
