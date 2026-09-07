"""Merge public candidate outputs into PIA hosting without exposing other settings."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

os.umask(0o077)

def aws(region, *args):
    result = subprocess.run(["aws", "--profile", "pia", *args, "--region", region], capture_output=True, text=True)
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}

assert aws("us-east-2", "sts", "get-caller-identity")["Account"] == "426771918029"
stack = aws("us-east-2", "cloudformation", "describe-stacks", "--stack-name", "mighty-api-production")["Stacks"][0]
assert stack["StackStatus"] == "UPDATE_COMPLETE"
outputs = {o["OutputKey"]: o["OutputValue"] for o in stack["Outputs"]}
updates = {"VITE_CANDIDATE_API_BASE": outputs["CandidateApiUrl"], "VITE_CANDIDATE_COGNITO_REGION": "us-east-2", "VITE_CANDIDATE_COGNITO_CLIENT_ID": outputs["CandidateUserPoolClientId"]}
app = aws("us-west-1", "amplify", "get-app", "--app-id", "d1c230b674qax4")["app"]
environment = app["environmentVariables"]
backup = Path.home() / ".local/share/pia/amplify-before-candidates.json"
backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
if not backup.exists(): backup.write_text(json.dumps(environment))
environment.update(updates)
with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as f:
    json.dump(environment, f); f.flush()
    aws("us-west-1", "amplify", "update-app", "--app-id", "d1c230b674qax4", "--environment-variables", "file://" + f.name, "--query", "app.name")
local = Path("../pia-counties/.env")
lines = local.read_text().splitlines() if local.exists() else []
lines = [line for line in lines if line.split("=", 1)[0] not in updates]
local.write_text("\n".join(lines + [key + "=" + value for key, value in updates.items()]) + "\n")
print("Configured public candidate API/Cognito identifiers in PIA Amplify and local frontend. Existing news, Mighty and other settings preserved.")
