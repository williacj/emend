// ABOUTME: Deterministic Claude argv-compatible process for the J7 browser acceptance journey.
// ABOUTME: Initializes/discovers the real MCP server and records its actual decision; never executes commands.
use fake_agent::{HttpToolServer, ToolServer};
use serde_json::{json, Value};
use std::io::{Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("2.1.263 (permission fixture)");
        return Ok(());
    }
    let config_at = args
        .iter()
        .position(|arg| arg == "--mcp-config")
        .ok_or("missing injected config")?;
    let config: Value =
        serde_json::from_str(args.get(config_at + 1).ok_or("missing config value")?)?;
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt)?;
    let mode = ["allow", "deny", "stop", "script"]
        .into_iter()
        .find(|mode| prompt.contains(&format!("permission fixture {mode}")))
        .ok_or("unrecognized permission fixture prompt")?;
    let mut client = HttpToolServer::from_mcp_config(&config)?;
    client.initialize()?;
    emit(
        json!({"type":"system","subtype":"init","model":"permission-fixture","session_id":"permission-fixture","claude_code_version":"2.1.263","mcp_servers":[{"name":"emend","status":"connected"}]}),
    )?;
    if mode == "script" {
        let path = std::env::current_dir()?.join("permission-witness.py");
        std::fs::write(&path, "print('permission fixture')\n")?;
        let path = path.to_string_lossy().replace('\\', "/");
        let mut decisions = Vec::new();
        for chapter in [1, 2] {
            decisions.push(client.call("permission_request", &json!({"tool_name":"Bash","input":{"command":format!("python3 '{path}' --chapter {chapter}"),"description":"Permission script witness"},"tool_use_id":format!("script-{chapter}")}))?);
        }
        std::fs::write("permission-script.json", serde_json::to_string(&decisions)?)?;
    } else {
        let decision = client.call("permission_request", &json!({"tool_name":"Bash","input":{"command":"python3 permission-witness.py","description":"Permission acceptance witness"},"tool_use_id":"permission-fixture-call"}))?;
        std::fs::write(format!("permission-{mode}.json"), decision.to_string())?;
    }
    emit(
        json!({"type":"result","subtype":"success","session_id":"permission-fixture","is_error":false,"result":"Permission decision received"}),
    )
}

fn emit(event: Value) -> Result<(), Box<dyn std::error::Error>> {
    provider_contract::validate(provider_contract::Schema::ClaudeStreamEvent, &event)
        .map_err(|errors| errors.join("; "))?;
    println!("{event}");
    std::io::stdout().flush()?;
    Ok(())
}
