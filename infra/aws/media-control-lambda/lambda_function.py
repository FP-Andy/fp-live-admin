import json
import os

import boto3


ec2 = boto3.client("ec2")

INSTANCE_ID = os.getenv("MEDIA_INSTANCE_ID", "").strip()
INSTANCE_NAME = os.getenv("MEDIA_INSTANCE_NAME", "live-admin-media").strip() or "live-admin-media"
AUTH_TOKEN = os.getenv("MEDIA_CONTROL_TOKEN", "").strip()
ALLOWED_ORIGIN = os.getenv("MEDIA_CONTROL_ALLOWED_ORIGIN", "*").strip() or "*"


def _response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
        "body": json.dumps(body),
    }


def _resolve_instance_id() -> str:
    if INSTANCE_ID:
        return INSTANCE_ID

    response = ec2.describe_instances(
        Filters=[
            {"Name": "tag:Name", "Values": [INSTANCE_NAME]},
            {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
        ]
    )
    for reservation in response.get("Reservations", []):
        for instance in reservation.get("Instances", []):
            return instance["InstanceId"]
    raise RuntimeError("Media instance not found")


def _describe(instance_id: str) -> dict:
    response = ec2.describe_instances(InstanceIds=[instance_id])
    reservations = response.get("Reservations", [])
    if not reservations or not reservations[0].get("Instances"):
        raise RuntimeError("Instance not found")
    instance = reservations[0]["Instances"][0]
    return {
        "ok": True,
        "provider": "aws",
        "instance_id": instance["InstanceId"],
        "instance_name": next((tag["Value"] for tag in instance.get("Tags", []) if tag["Key"] == "Name"), INSTANCE_NAME),
        "state": instance.get("State", {}).get("Name", "unknown"),
        "public_ip": instance.get("PublicIpAddress"),
        "private_ip": instance.get("PrivateIpAddress"),
    }


def lambda_handler(event, context):
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return _response(200, {"ok": True})

    if AUTH_TOKEN:
        auth_header = (event.get("headers") or {}).get("authorization") or (event.get("headers") or {}).get("Authorization")
        expected = f"Bearer {AUTH_TOKEN}"
        if auth_header != expected:
            return _response(401, {"ok": False, "detail": "Unauthorized"})

    try:
        payload = json.loads(event.get("body") or "{}")
    except Exception:
        payload = {}

    action = str(payload.get("action") or "").strip().lower()
    if action not in {"status", "start", "stop"}:
        return _response(400, {"ok": False, "detail": "Invalid action"})

    try:
        instance_id = str(payload.get("instance_id") or _resolve_instance_id()).strip()
        if action == "status":
            return _response(200, _describe(instance_id))
        if action == "start":
            ec2.start_instances(InstanceIds=[instance_id])
            data = _describe(instance_id)
            data["detail"] = "Start requested"
            return _response(200, data)
        ec2.stop_instances(InstanceIds=[instance_id])
        data = _describe(instance_id)
        data["detail"] = "Stop requested"
        return _response(200, data)
    except Exception as ex:
        return _response(500, {"ok": False, "detail": str(ex)})
