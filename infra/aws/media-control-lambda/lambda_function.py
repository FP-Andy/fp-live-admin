import json
import os
from datetime import datetime, timedelta, timezone

import boto3


ec2 = boto3.client("ec2")
cloudwatch = boto3.client("cloudwatch")

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
    instance_type = instance.get("InstanceType")
    state = instance.get("State", {}).get("Name", "unknown")
    metrics = _cloudwatch_metrics(instance_id) if state == "running" else {"available": False}
    return {
        "ok": True,
        "provider": "aws",
        "instance_id": instance["InstanceId"],
        "instance_name": next((tag["Value"] for tag in instance.get("Tags", []) if tag["Key"] == "Name"), INSTANCE_NAME),
        "instance_type": instance_type,
        "state": state,
        "public_ip": instance.get("PublicIpAddress"),
        "private_ip": instance.get("PrivateIpAddress"),
        "metrics": metrics,
    }


def _cloudwatch_metrics(instance_id: str) -> dict:
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=15)
    try:
        response = cloudwatch.get_metric_statistics(
            Namespace="AWS/EC2",
            MetricName="CPUUtilization",
            Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
            StartTime=start,
            EndTime=end,
            Period=300,
            Statistics=["Average", "Maximum"],
            Unit="Percent",
        )
    except Exception as ex:
        return {"available": False, "detail": str(ex)}

    datapoints = sorted(response.get("Datapoints", []), key=lambda row: row.get("Timestamp", datetime.min.replace(tzinfo=timezone.utc)))
    if not datapoints:
        return {"available": False, "detail": "No recent CloudWatch datapoints"}
    latest = datapoints[-1]
    return {
        "available": True,
        "window_minutes": 15,
        "cpu_average_percent": round(float(latest.get("Average", 0.0)), 2),
        "cpu_max_percent": round(float(latest.get("Maximum", 0.0)), 2),
        "sample_time": latest.get("Timestamp").isoformat() if latest.get("Timestamp") else None,
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
