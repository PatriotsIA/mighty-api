"""Create the initial PIA reviewer without invitation mail or secret output."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

os.umask(0o077)

def aws(service, operation, payload=None, *arguments):
    command = ["aws", "--profile", "pia", service, operation, "--region", "us-east-2", *arguments]
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as temporary:
        if payload is not None:
            json.dump(payload, temporary)
            temporary.flush()
            command += ["--cli-input-json", "file://" + temporary.name]
        result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}

assert aws("sts", "get-caller-identity")["Account"] == "426771918029"
stack = aws("cloudformation", "describe-stacks", None, "--stack-name", "mighty-api-production")["Stacks"][0]
assert stack["StackStatus"] == "UPDATE_COMPLETE"
outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
pool = outputs["CandidateUserPoolId"]
username = "erik@patriotsinaction.com"
destination = Path.home() / ".local/share/pia/candidate-review.json"
destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
if destination.exists():
    previous = json.loads(destination.read_text())
    if previous["userPoolId"] != pool or previous["username"] != username:
        raise RuntimeError("Existing local reviewer credential belongs to a different pool; preserve it before bootstrapping another.")
    print("Existing reviewer credential retained: " + str(destination))
else:
    # Never reset an existing administrator's password as a deployment side effect.
    users = aws("cognito-idp", "list-users", {"UserPoolId": pool, "Filter": 'email = "' + username + '"'})["Users"]
    if users:
        raise RuntimeError("Reviewer already exists; use their existing credential instead of resetting it.")
    password = "Pia!7" + secrets.token_urlsafe(32)
    credential = {"username": username, "password": password, "userPoolId": pool, "clientId": outputs["CandidateUserPoolClientId"], "region": "us-east-2", "apiBase": outputs["CandidateApiUrl"]}
    destination.write_text(json.dumps(credential, indent=2) + "\n")
    destination.chmod(0o600)
    aws("cognito-idp", "admin-create-user", {"UserPoolId": pool, "Username": username, "MessageAction": "SUPPRESS", "UserAttributes": [{"Name": "email", "Value": username}, {"Name": "email_verified", "Value": "true"}]})
    aws("cognito-idp", "admin-add-user-to-group", {"UserPoolId": pool, "Username": username, "GroupName": "admins"})
    aws("cognito-idp", "admin-set-user-password", {"UserPoolId": pool, "Username": username, "Password": password, "Permanent": True})
    print("Reviewer created; owner-only credential saved at " + str(destination))
