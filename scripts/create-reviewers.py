"""Provision requested PIA reviewers without invitation mail or password resets."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import string
import subprocess
import tempfile
import urllib.request

os.umask(0o077)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("emails", nargs="+")
args = parser.parse_args()
emails = list(dict.fromkeys(email.strip().lower() for email in args.emails))
if not all(re.fullmatch(r"[a-z0-9._+-]+@patriotsinaction\.com", email) for email in emails):
    parser.error("Supply PIA staff email addresses.")


def aws(service, operation, payload=None):
    command = ["aws", "--profile", "pia", service, operation, "--region", "us-east-2"]
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
stack = aws("cloudformation", "describe-stacks", {"StackName": "mighty-api-production"})["Stacks"][0]
assert stack["StackStatus"] == "UPDATE_COMPLETE"
outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
pool = outputs["CandidateUserPoolId"]
destination = Path.home() / ".local/share/pia/candidate-reviewers.json"
destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
credentials = json.loads(destination.read_text()) if destination.exists() else {
    "userPoolId": pool,
    "clientId": outputs["CandidateUserPoolClientId"],
    "region": "us-east-2",
    "apiBase": outputs["CandidateApiUrl"],
    "accounts": {},
}
assert credentials["userPoolId"] == pool, "Preserve credentials for the original user pool."


def save():
    with tempfile.NamedTemporaryFile(mode="w", dir=destination.parent, delete=False) as temporary:
        json.dump(credentials, temporary, indent=2)
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary.name, destination)
    destination.chmod(0o600)


for email in emails:
    users = aws("cognito-idp", "list-users", {"UserPoolId": pool, "Filter": 'email = "' + email + '"'})["Users"]
    account = credentials["accounts"].get(email)
    if users and not account:
        raise RuntimeError(email + " already exists; obtain its current credential instead of resetting its password.")
    if not account:
        account = {"username": email, "password": "Pia!7" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(19))}
        credentials["accounts"][email] = account
        save()  # Retain the credential if provisioning is interrupted.
    if not users:
        user = aws("cognito-idp", "admin-create-user", {
            "UserPoolId": pool, "Username": email, "MessageAction": "SUPPRESS",
            "TemporaryPassword": account["password"],
            "UserAttributes": [{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"}],
        })["User"]
    else:
        user = users[0]
    if user["UserStatus"] == "FORCE_CHANGE_PASSWORD":
        aws("cognito-idp", "admin-set-user-password", {"UserPoolId": pool, "Username": email, "Password": account["password"], "Permanent": True})
    aws("cognito-idp", "admin-add-user-to-group", {"UserPoolId": pool, "Username": email, "GroupName": "admins"})
    auth = aws("cognito-idp", "initiate-auth", {
        "ClientId": credentials["clientId"], "AuthFlow": "USER_PASSWORD_AUTH",
        "AuthParameters": {"USERNAME": email, "PASSWORD": account["password"]},
    })["AuthenticationResult"]
    request = urllib.request.Request(credentials["apiBase"] + "/v1/admin/candidates?status=pending&limit=1", headers={"Authorization": "Bearer " + auth["IdToken"]})
    with urllib.request.urlopen(request, timeout=30) as response:
        assert response.status == 200 and isinstance(json.load(response)["data"], list)
    aws("cognito-idp", "global-sign-out", {"AccessToken": auth["AccessToken"]})
    account["verifiedAt"] = datetime.now(timezone.utc).isoformat()
    save()
    print(email + ": administrator created/retained; sign-in and protected review API verified.")
print("Credentials saved with owner-only permissions at " + str(destination))
