"""Match-local idempotency checks shared by FLA write routes."""
from fastapi import HTTPException
from datetime import datetime


def require_sport(match, sport):
    if str(match.sport or 'FOOTBALL').upper() != sport:
        raise HTTPException(409, f'This operation requires a {sport} match')


def require_same_request(existing, match_id, expected):
    # Null clock requests retain their originally resolved clock on a retry.
    # Derived xGOT is not compared: its input fields are authoritative.
    if existing.match_id != match_id or any(getattr(existing, key) != value for key, value in expected.items()):
        raise HTTPException(409, 'Request ID already belongs to a different match or payload')


def state_response(state, revision, clock_speed=1):
    return {'command_revision':revision,'state':None if state is None else {
        'clock_ms':state.clock_ms,'running':state.running,'possession_team':state.possession_team,
        'selected_team':state.selected_team,'attack_lr':state.attack_lr,
        # UTC anchors allow clients to restore elapsed time without trusting the
        # workstation's timezone or wall-clock offset. No historical rows change.
        'sampled_at':state.created_at.isoformat()+'Z' if state.created_at else None,
        'server_now':datetime.utcnow().isoformat()+'Z', 'clock_speed':clock_speed}}
