"""Match-local idempotency checks shared by FLA write routes."""
from fastapi import HTTPException


def require_sport(match, sport):
    if str(match.sport or 'FOOTBALL').upper() != sport:
        raise HTTPException(409, f'This operation requires a {sport} match')


def require_same_request(existing, match_id, expected):
    # Null clock requests retain their originally resolved clock on a retry.
    # Derived xGOT is not compared: its input fields are authoritative.
    if existing.match_id != match_id or any(getattr(existing, key) != value for key, value in expected.items()):
        raise HTTPException(409, 'Request ID already belongs to a different match or payload')


def state_response(state, revision):
    return {'command_revision':revision,'state':None if state is None else {
        'clock_ms':state.clock_ms,'running':state.running,'possession_team':state.possession_team,
        'selected_team':state.selected_team,'attack_lr':state.attack_lr}}
