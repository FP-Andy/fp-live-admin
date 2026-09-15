"""Allowlisted administrators, shared operator codes and revocable sessions."""
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import secrets
import uuid

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth_security import fingerprint, hash_secret, normalize_login, valid_secret_hash, verify_secret
from .db import get_db
from .models import AdminAccount, AuditLog, AuthSession, LoginThrottle, OperatorAccessPolicy, User
from .schemas import LoginRequest, SessionUserResponse

router = APIRouter()
COOKIE_NAME = "live_admin_session"
SESSION_MAX_AGE = int(os.getenv("SESSION_MAX_AGE_SECONDS", str(60 * 60 * 24 * 14)))
LOGIN_WINDOW = timedelta(minutes=15)
MAX_LOGIN_FAILURES = 20
_DUMMY_HASH = hash_secret(secrets.token_urlsafe(32))


def bootstrap_admin_accounts(db: Session, source: str | None = None) -> int:
    """Apply a private hash manifest. Historical User rows remain intact."""
    source = source or os.getenv("FPC_ADMIN_ACCOUNTS_FILE", "")
    if not source:
        return 0
    payload = json.loads(Path(source).read_text())
    accounts = payload.get("accounts")
    if payload.get("version") != 1 or not isinstance(accounts, list) or not accounts:
        raise ValueError("A non-empty administrator manifest is required")
    seen = set()
    for entry in accounts:
        if not isinstance(entry, dict) or not isinstance(entry.get("login"), str) or not isinstance(entry.get("name"), str):
            raise ValueError("Invalid administrator entry")
        login = normalize_login(str(entry.get("login", "")))
        name = str(entry.get("name", "")).strip()
        if (not login or len(login) > 80 or not name or len(name) > 80
                or login in seen or not valid_secret_hash(entry.get("password_hash", ""))):
            raise ValueError("Invalid or duplicate administrator entry")
        seen.add(login)
    for entry in accounts:
        login = normalize_login(entry["login"])
        user_id = "admin-" + fingerprint(login)[:40]
        user = db.get(User, user_id)
        if user is None:
            user = User(id=user_id, name=entry["name"].strip(), role="SUPERADMIN")
            db.add(user)
            db.flush()
        else:
            user.name = entry["name"].strip()
            user.role = "SUPERADMIN"
        account = db.get(AdminAccount, login)
        if account is None:
            account = AdminAccount(login=login, user_id=user_id, password_hash=entry["password_hash"], active=True)
            db.add(account)
        else:
            account.user_id = user_id
            account.password_hash = entry["password_hash"]
            account.active = True
    for account in db.scalars(select(AdminAccount).where(AdminAccount.login.not_in(seen))):
        account.active = False
    db.commit()
    return len(accounts)


def user_from_token(db: Session, token: str | None) -> User | None:
    if not token or not token.startswith("v2_") or len(token) > 200:
        return None
    session = db.get(AuthSession, fingerprint(token))
    if not session or session.expires_at <= datetime.utcnow():
        return None
    user = db.get(User, session.user_id)
    if not user or user.role != session.role:
        return None
    if session.role == "SUPERADMIN":
        account = db.scalar(select(AdminAccount).where(AdminAccount.user_id == user.id))
        if not account or not account.active or fingerprint(account.password_hash) != session.credential_version:
            return None
    elif session.role == "OPERATOR":
        policy = db.get(OperatorAccessPolicy, "operator")
        if not policy or not policy.code_hash or policy.version != session.credential_version:
            return None
    else:
        return None
    return user


def get_session_user(
    session_cookie: str | None = Cookie(default=None, alias=COOKIE_NAME),
    db: Session = Depends(get_db),
) -> User | None:
    return user_from_token(db, session_cookie)


def session_user_id(user: User | None = Depends(get_session_user)) -> str | None:
    return user.id if user else None


def require_session_user(user: User | None = Depends(get_session_user)) -> User:
    if not user:
        raise HTTPException(401, "로그인이 필요합니다.")
    return user


def require_admin(user: User = Depends(require_session_user)) -> User:
    if user.role != "SUPERADMIN":
        raise HTTPException(403, "관리자만 접근할 수 있습니다.")
    return user


def cookie_options(request: Request) -> dict:
    host = (request.headers.get("x-forwarded-host") or request.url.hostname or "").split(":", 1)[0].lower()
    if host == "fineludens.kr" or host.endswith(".fineludens.kr"):
        return {"domain": ".fineludens.kr", "secure": True}
    return {"secure": request.url.scheme == "https"}


def audit(db: Session, actor: User, action: str) -> None:
    db.add(AuditLog(actor_id=actor.id, actor_name=actor.name, actor_role=actor.role,
                    action=action, target_type="access", target_id=actor.id,
                    severity="INFO", details={}))


def login_throttle(db: Session, request: Request) -> LoginThrottle:
    # Use the server's resolved peer address, not a client-supplied forwarding header.
    key = fingerprint(request.client.host if request.client else "unknown")
    throttle = db.scalar(select(LoginThrottle).where(LoginThrottle.key == key).with_for_update())
    if not throttle:
        throttle = LoginThrottle(key=key, failures=0, window_start=datetime.utcnow())
        db.add(throttle)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            throttle = db.scalar(select(LoginThrottle).where(LoginThrottle.key == key).with_for_update())
    if datetime.utcnow() - throttle.window_start >= LOGIN_WINDOW:
        throttle.failures = 0
        throttle.window_start = datetime.utcnow()
    if throttle.failures >= MAX_LOGIN_FAILURES:
        raise HTTPException(429, "로그인 시도가 많습니다. 잠시 후 다시 시도하세요.", headers={"Retry-After": "900"})
    return throttle


@router.post("/api/session/login", response_model=SessionUserResponse)
def login(body: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    throttle = login_throttle(db, request)
    name = body.name.strip()
    user = None
    credential_version = ""
    if body.mode == "ADMIN":
        account = db.get(AdminAccount, normalize_login(name))
        encoded = account.password_hash if account and account.active else _DUMMY_HASH
        valid = verify_secret(body.access_key, encoded)
        if account and account.active and valid:
            user = db.get(User, account.user_id)
            if user and user.role == "SUPERADMIN":
                credential_version = fingerprint(account.password_hash)
            else:
                user = None
    else:
        policy = db.scalar(select(OperatorAccessPolicy).where(OperatorAccessPolicy.id == "operator").with_for_update())
        valid = verify_secret(body.access_key, policy.code_hash if policy and policy.code_hash else _DUMMY_HASH)
        if name and policy and policy.code_hash and valid:
            # An operator name cannot overwrite an administrator or another login.
            user = User(id="operator-" + uuid.uuid4().hex, name=name, role="OPERATOR")
            db.add(user)
            db.flush()
            credential_version = policy.version
    if not user:
        throttle.failures += 1
        db.commit()
        raise HTTPException(401, "아이디 또는 액세스 키가 올바르지 않습니다.")
    token = "v2_" + secrets.token_urlsafe(48)
    db.execute(delete(AuthSession).where(AuthSession.expires_at <= datetime.utcnow()))
    db.add(AuthSession(token_hash=fingerprint(token), user_id=user.id, role=user.role,
                       credential_version=credential_version,
                       expires_at=datetime.utcnow() + timedelta(seconds=SESSION_MAX_AGE)))
    audit(db, user, "SESSION_LOGIN")
    db.commit()
    response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax", path="/",
                        max_age=SESSION_MAX_AGE, **cookie_options(request))
    response.headers["Cache-Control"] = "no-store"
    return {"id": user.id, "name": user.name, "role": user.role}


@router.post("/api/session/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == fingerprint(token)))
        db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    options = cookie_options(request)
    if options.get("domain"):
        response.delete_cookie(COOKIE_NAME, path="/", domain=options["domain"], secure=True)
    return {"ok": True}


@router.get("/api/session/me", response_model=SessionUserResponse)
def current_session(response: Response, user: User = Depends(require_session_user)):
    response.headers["Cache-Control"] = "no-store"
    return {"id": user.id, "name": user.name, "role": user.role}


class OperatorCodeRequest(BaseModel):
    code: str = Field(min_length=8, max_length=200, repr=False)


def access_status(db: Session) -> dict:
    policy = db.get(OperatorAccessPolicy, "operator")
    admins = db.execute(select(AdminAccount, User).join(User, AdminAccount.user_id == User.id)
                        .where(AdminAccount.active.is_(True)).order_by(AdminAccount.login)).all()
    actor = db.get(User, policy.updated_by) if policy and policy.updated_by else None
    return {"admins": [{"login": account.login, "name": user.name, "role": "SUPERADMIN"} for account, user in admins],
            "operator_enabled": bool(policy and policy.code_hash),
            "updated_at": policy.updated_at.isoformat() if policy else None,
            "updated_by": actor.name if actor else None}


@router.get("/api/admin/access")
def get_access(response: Response, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    response.headers["Cache-Control"] = "no-store"
    return access_status(db)


def set_operator_policy(db: Session, user: User, encoded: str | None) -> dict:
    policy = db.scalar(select(OperatorAccessPolicy).where(OperatorAccessPolicy.id == "operator").with_for_update())
    if not policy:
        policy = OperatorAccessPolicy(id="operator")
        db.add(policy)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            policy = db.scalar(select(OperatorAccessPolicy).where(OperatorAccessPolicy.id == "operator").with_for_update())
    policy.code_hash = encoded
    policy.version = uuid.uuid4().hex
    policy.updated_by = user.id
    policy.updated_at = datetime.utcnow()
    db.execute(delete(AuthSession).where(AuthSession.role == "OPERATOR"))
    audit(db, user, "OPERATOR_CODE_CHANGED" if encoded else "OPERATOR_ACCESS_DISABLED")
    db.commit()
    return access_status(db)


@router.put("/api/admin/access/operator-code")
def set_operator_code(body: OperatorCodeRequest, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    if len(body.code.strip()) < 8:
        raise HTTPException(422, "운영자 코드는 공백을 제외하고 8자 이상 입력하세요.")
    return set_operator_policy(db, user, hash_secret(body.code))


@router.delete("/api/admin/access/operator-code")
def disable_operator_access(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    return set_operator_policy(db, user, None)
