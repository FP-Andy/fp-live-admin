# xGOT v1 Guide

## What xGOT v1 Means

xGOT v1 is our first lightweight on-target shooting quality model.

- `xG` answers: how good was the chance before the shot?
- `xGOT v1` answers: after the shot was taken, how dangerous was the actual shot placement and execution?

This version is not a tracking-based model. It is an operator-input model built for live use.

## What Operators Record

To estimate xGOT v1:

1. Record the normal shot location on the half-pitch.
2. Estimate the normal xG.
3. Turn on `On Target` if the shot is a valid shot on target.
4. Click the goalmouth map where the shot was heading.
5. Select shot speed:
   - `Slow`
   - `Normal`
   - `Fast`
6. Optionally mark:
   - `Goal`
   - `Header`
   - `Weak Foot`
7. Press `Estimate xGOT`.

## How to Read the Value

General interpretation:

- `0.00 to 0.15`
  - weak or central on-target shot
- `0.15 to 0.30`
  - moderate threat, usually decent placement or decent base xG
- `0.30 to 0.45`
  - strong on-target shot
- `0.45+`
  - very dangerous shot, usually upper corner or strong placement with speed

## Important Notes

- xGOT v1 still includes base xG.
- This means a low-quality chance can improve a lot with strong placement, but it does not become elite automatically.
- `Fast` matters more near the upper corners than in the keeper-zone.
- Central low shots stay relatively low even when speed is fast.

## Example Outcomes

Using a low base chance around `xG = 0.10`:

- center-low + slow: about `0.088`
- center-low + fast: about `0.096`
- center-mid + normal: about `0.178`
- top corner + normal: about `0.409`
- top corner + fast: about `0.455`

## Why We Built It This Way

This tool is made for live operation, so we prioritized:

- quick input
- consistent operator workflow
- intuitive goalmouth clicking
- a model that rewards placement and speed without ignoring original chance quality

## Current Limitations

- no goalkeeper tracking
- no ball-speed sensor or video-derived velocity
- no spin or trajectory data
- no separate keeper-position model

This is why the model is called `xGOT v1` and should be treated as an operational estimation tool, not a final research-grade post-shot model.
