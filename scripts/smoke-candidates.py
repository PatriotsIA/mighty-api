"""Exercise deployed candidates with suppressed mail; remove only the test row."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import uuid

os.umask(0o077)

def aws(service, operation, payload):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as f:
        json.dump(payload, f); f.flush()
        result = subprocess.run(["aws", "--profile", "pia", service, operation, "--region", "us-east-2", "--cli-input-json", "file://" + f.name], capture_output=True, text=True)
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}

stack = aws("cloudformation", "describe-stacks", {"StackName": "mighty-api-production"})["Stacks"][0]
assert stack["StackStatus"] == "UPDATE_COMPLETE"
assert next(p["ParameterValue"] for p in stack["Parameters"] if p["ParameterKey"] == "CandidateNotificationsEnabled") == "false", "Disable notifications before the smoke test."
outputs = {o["OutputKey"]: o["OutputValue"] for o in stack["Outputs"]}
credential = json.loads((Path.home() / ".local/share/pia/candidate-review.json").read_text())
assert credential["userPoolId"] == outputs["CandidateUserPoolId"]
auth = aws("cognito-idp", "initiate-auth", {"ClientId": credential["clientId"], "AuthFlow": "USER_PASSWORD_AUTH", "AuthParameters": {"USERNAME": credential["username"], "PASSWORD": credential["password"]}})
token = auth["AuthenticationResult"]["IdToken"]
base = outputs["CandidateApiUrl"]

def request(method, path, body=None, authenticated=False, expected=200):
    headers = {"Origin": "https://patriotsinaction.com", "Content-Type": "application/json"}
    if authenticated: headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try: response = urllib.request.urlopen(req, timeout=30)
    except urllib.error.HTTPError as error: response = error
    data = json.loads(response.read() or "{}")
    assert response.status == expected, f"{method} {path}: expected {expected}, got {response.status} ({data.get('error', {}).get('code', '')})"
    assert response.headers.get("Access-Control-Allow-Origin") == headers["Origin"], "CORS mismatch"
    return data

request("GET", "/health")
catalog = request("GET", "/v1/candidates?limit=100")["data"]
assert len(catalog) == 56
request("GET", "/v1/admin/candidates", expected=401)
request("GET", "/v1/admin/candidates", authenticated=True)
test_id = "deployment-smoke-" + uuid.uuid4().hex[:12]
candidate = {**catalog[0], "id": test_id}
payload = {"candidate": candidate, "submitter": {"submitterName": "Deployment verification", "submitterEmail": credential["username"], "submitterRole": "campaign"}, "consent": True, "attestation": True, "honeypot": ""}
created = False
try:
    # The smoke profile copies an already-public seed profile; no invented
    # candidate information is published during the short approval check.
    created = True
    receipt = request("POST", "/v1/candidates/submissions", payload, expected=201)["data"]
    assert receipt["submissionId"] == test_id
    repeated = request("POST", "/v1/candidates/submissions", payload)["data"]
    assert repeated["submissionId"] == test_id
    request("GET", "/v1/candidates/" + test_id, expected=404)
    record = request("GET", "/v1/admin/candidates/" + test_id, authenticated=True)["data"]
    edited = request("PATCH", "/v1/admin/candidates/" + test_id, {"expectedRevision": record["revision"], "candidate": {"office": candidate["office"]}}, authenticated=True)["data"]
    request("POST", "/v1/admin/candidates/" + test_id + "/approve", {"expectedRevision": edited["revision"]}, authenticated=True)
    public = request("GET", "/v1/candidates/" + test_id)["data"]
    assert public["id"] == test_id
    assert not any(key in public for key in ["submitter", "reviewer", "reviewReason", "consent", "attestation"])
finally:
    if created:
        aws("dynamodb", "delete-item", {"TableName": outputs["CandidatesTableName"], "Key": {"submissionId": {"S": test_id}}, "ConditionExpression": "#source = :source AND submitter.submitterEmail = :email", "ExpressionAttributeNames": {"#source": "source"}, "ExpressionAttributeValues": {":source": {"S": "submission"}, ":email": {"S": credential["username"]}}})
request("GET", "/v1/candidates/" + test_id, expected=404)
for attempt in range(10):
    if len(request("GET", "/v1/candidates?limit=100")["data"]) == 56: break
    time.sleep(0.5)
else: raise RuntimeError("Public index did not settle after test cleanup")
print("PASS: Cognito login, public/authenticated CORS, private submission, identical retry, moderation, approval, public privacy, and test-record cleanup. Public catalog contains 56 profiles; no notification sent.")
