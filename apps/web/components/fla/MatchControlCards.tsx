/** Shared cards extracted from the FLA match controller. Both workspaces use this UI. */
import {Fragment, type Dispatch, type SetStateAction, type MouseEvent} from 'react';
import {ComposedChart, Area, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceDot, ReferenceLine, ResponsiveContainer} from 'recharts';
import AttackDirectionPitch from '../AttackDirectionPitch';
import {FutsalShotPitch} from './FutsalShotPitch';
type Team='HOME'|'AWAY';
type Lane='LEFT'|'CENTER'|'RIGHT';
type AttackLR='L2R'|'R2L';
type Point={x:number;y:number};
type LineupPlayer={number:string;name:string};
const PITCH_WIDTH=68, XG_VISIBLE_LENGTH=40;
function formatCreatedAtKst(createdAt:string){
 const raw=/Z$|[+-]\d{2}:\d{2}$/.test(createdAt)?createdAt:`${createdAt}Z`;
 return new Date(raw).toLocaleTimeString('ko-KR',{hour12:false,timeZone:'Asia/Seoul'});
}

export function MatchPossessionCard({possessionTeam, matchTeams, summary, canWrite, isResettingPossession, resetPossession, changePossession}:{possessionTeam:Team|'NONE'; matchTeams:{homeTeam?:string;awayTeam?:string}|null; summary:any; canWrite:boolean; isResettingPossession:boolean; resetPossession:()=>void; changePossession:(team:Team|'NONE')=>void;}){
 return (<div className="card card-panel grid" style={{ minHeight: 180, gap: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>점유 팀</h3>
                <button className="btn-danger" onClick={resetPossession} disabled={!canWrite || isResettingPossession}>
                  {isResettingPossession ? '초기화 중…' : '초기화'}
                </button>
              </div>
              <div className="row">
                <span>현재: {possessionTeam === 'HOME' ? matchTeams?.homeTeam || '홈' : possessionTeam === 'AWAY' ? matchTeams?.awayTeam || '어웨이' : '루즈볼'}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span>Home</span>
                <strong>{summary?.possession?.home_pct?.toFixed(2) || '0.00'}% : {summary?.possession?.away_pct?.toFixed(2) || '0.00'}%</strong>
                <span>Away</span>
              </div>
              <div className="fla-possession-buttons">
                <button className={`fla-home ${possessionTeam === 'HOME' ? 'selected' : ''}`} aria-pressed={possessionTeam === 'HOME'} onClick={() => changePossession('HOME')} disabled={!canWrite}>{matchTeams?.homeTeam || '홈'} <span className="kbd">Q</span></button>
                <button className={`fla-away ${possessionTeam === 'AWAY' ? 'selected' : ''}`} aria-pressed={possessionTeam === 'AWAY'} onClick={() => changePossession('AWAY')} disabled={!canWrite}>{matchTeams?.awayTeam || '어웨이'} <span className="kbd">W</span></button>
                <button className={possessionTeam === 'NONE' ? 'btn-active' : ''} aria-pressed={possessionTeam === 'NONE'} onClick={() => changePossession('NONE')} disabled={!canWrite}>루즈볼 <span className="kbd">E</span></button>
              </div>
            </div>);
}

export function MatchAttackCard({attackLR, selectedTeam, pendingLane, matchTeams, summary, canWrite, canRecord=canWrite, changeAttackDirection, selectEventTeam, setPendingLane, sendLane}:{attackLR:AttackLR; selectedTeam:Team; pendingLane:Lane; matchTeams:{homeTeam?:string;awayTeam?:string}|null; summary:any; canWrite:boolean; canRecord?:boolean; changeAttackDirection:(direction:AttackLR)=>void; selectEventTeam:(team:Team)=>void; setPendingLane:(lane:Lane)=>void; sendLane:(lane:Lane)=>void;}){
 return (<div className="card card-panel grid fla-attack-card" role="group" aria-label="공격 방향 기록">
              <h3>공격 방향 기록</h3>
              <div className="fla-attack-layout">
              <div className="fla-attack-controls">
              <div className="row">
                <span className="fla-control-label">홈 공격 방향</span>
                <button className={attackLR === 'L2R' ? 'btn-active' : ''} aria-pressed={attackLR === 'L2R'} onClick={() => changeAttackDirection('L2R')} disabled={!canWrite}>오른쪽 →</button>
                <button className={attackLR === 'R2L' ? 'btn-active' : ''} aria-pressed={attackLR === 'R2L'} onClick={() => changeAttackDirection('R2L')} disabled={!canWrite}>← 왼쪽</button>
              </div>
              <div className="row">
                <span className="fla-control-label">기록 팀</span>
                <button className={selectedTeam === 'HOME' ? 'btn-active' : ''} aria-pressed={selectedTeam === 'HOME'} onClick={() => selectEventTeam('HOME')} disabled={!canWrite}>{matchTeams?.homeTeam || '홈'}</button>
                <button className={selectedTeam === 'AWAY' ? 'btn-active' : ''} aria-pressed={selectedTeam === 'AWAY'} onClick={() => selectEventTeam('AWAY')} disabled={!canWrite}>{matchTeams?.awayTeam || '어웨이'}</button>

              </div>
              <div className="row">
                <span className="fla-control-label">공격 위치</span>
                <button className={pendingLane === 'LEFT' ? 'btn-active' : ''} aria-pressed={pendingLane === 'LEFT'} onClick={() => setPendingLane('LEFT')} disabled={!canWrite}>왼쪽 <span className="kbd">A</span></button>
                <button className={pendingLane === 'CENTER' ? 'btn-active' : ''} aria-pressed={pendingLane === 'CENTER'} onClick={() => setPendingLane('CENTER')} disabled={!canWrite}>중앙 <span className="kbd">S</span></button>
                <button className={pendingLane === 'RIGHT' ? 'btn-active' : ''} aria-pressed={pendingLane === 'RIGHT'} onClick={() => setPendingLane('RIGHT')} disabled={!canWrite}>오른쪽 <span className="kbd">D</span></button>

              </div>
              <div className="row">
                <button className="btn-primary" onClick={() => sendLane(pendingLane)} disabled={!canRecord}>공격 기록 <span className="kbd">Enter</span></button>
              </div>
              </div>
              <AttackDirectionPitch homeDirection={attackLR} team={selectedTeam} lane={pendingLane} teamName={selectedTeam === 'HOME' ? matchTeams?.homeTeam || '홈' : matchTeams?.awayTeam || '어웨이'} />
              </div>
              <details className="fla-lane-stats"><summary>공격 방향별 통계</summary><div className="muted">
                HOME Lane(events): L {summary?.lanes?.home?.left_pct?.toFixed(1) || '0'}% / C {summary?.lanes?.home?.center_pct?.toFixed(1) || '0'}% / R {summary?.lanes?.home?.right_pct?.toFixed(1) || '0'}% (n={summary?.lanes?.home?.total_count || 0})
                <br />
                AWAY Lane(events): L {summary?.lanes?.away?.left_pct?.toFixed(1) || '0'}% / C {summary?.lanes?.away?.center_pct?.toFixed(1) || '0'}% / R {summary?.lanes?.away?.right_pct?.toFixed(1) || '0'}% (n={summary?.lanes?.away?.total_count || 0})
              </div></details>
            </div>);
}

export function MatchShotCard({isFutsal, xgTeam, setXgTeam, xgPlayerKey, setXgPlayerKey, xgPlayerOptions, isOnTargetShot, setIsOnTargetShot, isGoalShot, setIsGoalShot, isHeaderShot, setIsHeaderShot, isOwnGoal, setIsOwnGoal, shotPoint, goalmouthPoint, canWrite, canRecord=canWrite, xgValue, setXgValue, xgotValue, estimateXgFromPitch, estimateXgotFromGoalmouth, submitXg, isSavingShot, onGoalmouthClick, onPitchClick, xgEstimateMeta, xgotEstimateMeta}:{isFutsal:boolean; xgTeam:Team; setXgTeam:(team:Team)=>void; xgPlayerKey:string; setXgPlayerKey:(value:string)=>void; xgPlayerOptions:LineupPlayer[]; isOnTargetShot:boolean; setIsOnTargetShot:Dispatch<SetStateAction<boolean>>; isGoalShot:boolean; setIsGoalShot:Dispatch<SetStateAction<boolean>>; isHeaderShot:boolean; setIsHeaderShot:Dispatch<SetStateAction<boolean>>; isOwnGoal:boolean; setIsOwnGoal:Dispatch<SetStateAction<boolean>>; shotPoint:Point|null; goalmouthPoint:Point|null; canWrite:boolean; canRecord?:boolean; xgValue:string; setXgValue:(value:string)=>void; xgotValue:string; estimateXgFromPitch:()=>void; estimateXgotFromGoalmouth:()=>void; submitXg:()=>void; isSavingShot:boolean; onGoalmouthClick:(event:MouseEvent<HTMLDivElement>)=>void; onPitchClick:(event:MouseEvent<HTMLDivElement>)=>void; xgEstimateMeta:string; xgotEstimateMeta:string;}){
 return (<div className="card card-panel grid fla-shot-card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>{isFutsal ? '슈팅 위협도 기록' : '슈팅 기록'}</h3>
                <select aria-label="슈팅 팀" value={xgTeam} onChange={(e) => setXgTeam(e.target.value as Team)}>
                  <option value="HOME">HOME</option>
                  <option value="AWAY">AWAY</option>
                </select>
                <select aria-label="슈팅 선수" value={xgPlayerKey} onChange={(e) => setXgPlayerKey(e.target.value)} disabled={!xgPlayerOptions.length}>
                  <option value="">{xgPlayerOptions.length ? '선수 선택 (선택)' : '등록된 선수 없음'}</option>
                  {xgPlayerOptions.map((player) => (
                    <option key={`${player.number}|${player.name}`} value={`${player.number}|${player.name}`}>
                      No.{player.number} {player.name}
                    </option>
                  ))}
                </select>

              </div>
            </div>
            <div className="row fla-shot-flags" style={{ gap: 10, flexWrap: 'wrap' }}>
              {!isFutsal ? <button className={isOnTargetShot ? 'btn-active' : ''} onClick={() => setIsOnTargetShot((prev) => !prev)} disabled={!canWrite}>유효슈팅</button> : null}
              <button className={isGoalShot ? 'btn-active' : ''} onClick={() => {
                const next = !isGoalShot;
                setIsGoalShot(next);
                // Futsal has no separate on-target toggle: keep it in sync with goals.
                if (isFutsal) setIsOnTargetShot(next);
              }} disabled={!canWrite}>골</button>
              {!isFutsal ? <button className={isHeaderShot ? 'btn-active' : ''} onClick={() => setIsHeaderShot((prev) => !prev)} disabled={!canWrite}>헤더</button> : null}
              <button
                className={isOwnGoal ? 'btn-active' : ''}
                onClick={() => setIsOwnGoal((prev) => !prev)}
                disabled={!canWrite}
                title="Own goal — counts on the scoreboard for the selected team"
              >
                OG
              </button>
              <span className="muted">
                {isOwnGoal
                  ? `Own goal → ${xgTeam} scores. Click pitch, then Record OG.`
                  : shotPoint
                  ? `shot=(${shotPoint.x}, ${shotPoint.y})`
                  : '피치에서 슈팅 위치를 선택하세요'}
              </span>
            </div>
            <div className="fla-shot-toolbar">
            <div className={`fla-shot-values ${isFutsal ? 'fla-shot-values-futsal' : ''}`}>
              <div className="fla-shot-value-row">
                <label htmlFor="fla-xg-value">{isFutsal ? 'Shot Threat' : 'xG'}</label>
                <input id="fla-xg-value" aria-label={isFutsal?'Shot Threat 값':'xG 값'} inputMode="decimal" value={xgValue} onChange={(e) => setXgValue(e.target.value)} placeholder={isFutsal ? '0.000–0.800' : 'xG'} />
                  <button className="btn-secondary" onClick={estimateXgFromPitch} disabled={!canWrite}>{isFutsal ? '위협도 추정' : 'xG 계산'}</button>
              </div>
              {!isFutsal ? <div className="fla-shot-value-row">
                <label htmlFor="fla-xgot-value">xGOT</label>
                <input id="fla-xgot-value" aria-label="xGOT 값" value={xgotValue} readOnly placeholder="xGOT" />
                <button className="btn-secondary" onClick={estimateXgotFromGoalmouth} disabled={!canWrite}>xGOT 계산</button>
              </div> : null}
            </div>
            <button className="btn-primary fla-shot-submit" onClick={submitXg} disabled={!canRecord || isSavingShot}>{isSavingShot ? '저장 중…' : isOwnGoal ? '자책골 기록' : '슈팅 기록'}</button>
            </div>
            <div className="fla-shot-surfaces">
              {isOnTargetShot ? (
                <div className="fla-goalmouth">
                  {isFutsal ? <p className="muted" style={{ margin: '0 0 10px' }}>골문을 눌러 골이 들어간 위치를 선택하세요.</p> : null}
                  <div className="fla-goalmouth-row" style={{ position: 'relative', width: '100%', minHeight: 108 }}>
                    <div
                      aria-label="골문 도착 위치 선택"
                      onClick={onGoalmouthClick}
                      style={{
                        position: 'relative',
                        width: 300,
                        maxWidth: '100%',
                        aspectRatio: isFutsal ? '3 / 2' : '3.2 / 1.15',
                        cursor: 'crosshair',
                        margin: '0 auto',
                      }}
                    >
                      {goalmouthPoint ? (
                        <div
                          className="muted"
                          style={{
                            position: 'absolute',
                            left: 10,
                            bottom: 8,
                            fontSize: 11,
                            whiteSpace: 'nowrap',
                            zIndex: 5,
                          }}
                        >
                          goalmouth=({goalmouthPoint.x.toFixed(3)}, {goalmouthPoint.y.toFixed(3)})
                        </div>
                      ) : null}
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          border: '4px solid rgba(255,255,255,0.95)',
                          borderBottomWidth: 2,
                          borderRadius: '8px 8px 0 0',
                          background:
                            'linear-gradient(180deg, rgba(20,52,109,0.72) 0%, rgba(20,52,109,0.3) 44%, rgba(255,255,255,0.03) 100%)',
                          boxShadow: '0 10px 28px rgba(15,23,42,0.32)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundImage:
                              'linear-gradient(rgba(255,255,255,0.58) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
                            backgroundSize: '8.5% 16%',
                            transform: 'perspective(260px) rotateX(14deg) scaleY(1.04)',
                            transformOrigin: 'top center',
                            opacity: 0.9,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: '-6%',
                            top: '5%',
                            bottom: '11%',
                            width: '9%',
                            borderLeft: '4px solid rgba(255,255,255,0.95)',
                            borderTop: '4px solid rgba(255,255,255,0.75)',
                            borderBottom: '2px solid rgba(255,255,255,0.16)',
                            transform: 'skewY(14deg)',
                            opacity: 0.92,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            right: '-6%',
                            top: '5%',
                            bottom: '11%',
                            width: '9%',
                            borderRight: '4px solid rgba(255,255,255,0.95)',
                            borderTop: '4px solid rgba(255,255,255,0.75)',
                            borderBottom: '2px solid rgba(255,255,255,0.16)',
                            transform: 'skewY(-14deg)',
                            opacity: 0.92,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: '33.33%',
                            top: 0,
                            bottom: 0,
                            borderLeft: '1px dashed rgba(255,255,255,0.42)',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: '66.66%',
                            top: 0,
                            bottom: 0,
                            borderLeft: '1px dashed rgba(255,255,255,0.42)',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: '50%',
                            borderTop: '1px dashed rgba(255,255,255,0.42)',
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: '15%',
                            background: 'linear-gradient(180deg, rgba(101,163,13,0.14), rgba(101,163,13,0.38))',
                          }}
                        />
                        {goalmouthPoint ? (
                          <div
                            style={{
                              position: 'absolute',
                              left: `${goalmouthPoint.x * 100}%`,
                              top: `${(1 - goalmouthPoint.y) * 100}%`,
                              width: 14,
                              height: 14,
                              borderRadius: '50%',
                              background: '#f97316',
                              border: '2px solid white',
                              transform: 'translate(-50%, -50%)',
                              boxShadow: '0 0 0 5px rgba(249,115,22,0.18)',
                              zIndex: 4,
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
              {isFutsal ? <FutsalShotPitch shotPoint={shotPoint} onClick={onPitchClick} isOnTarget={isOnTargetShot} /> : <>
              <div
                className="fla-shot-pitch" aria-label="슈팅 위치 선택"
                onClick={onPitchClick}
                style={{
                  position: 'relative',
                  width: '100%',
                  maxWidth: 520,
                  aspectRatio: '68 / 40',
                  border: '1px solid #1f2937',
                  borderRadius: 8,
                  cursor: 'crosshair',
                  background:
                    'repeating-linear-gradient(0deg, #3f7f3f 0 10%, #3a733a 10% 20%)',
                  overflow: 'visible',
                }}
              >
              <div style={{ position: 'absolute', inset: 0, border: '2px solid rgba(255,255,255,0.9)', borderRadius: 8 }} />
              <div
                style={{
                  position: 'absolute',
                  left: '44.62%',
                  top: -12,
                  width: '10.76%',
                  height: 12,
                  border: '2px solid rgba(255,255,255,0.95)',
                  borderBottom: 'none',
                  borderRadius: '6px 6px 0 0',
                  background: 'rgba(255,255,255,0.05)',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                }}
              />
              <div style={{ position: 'absolute', left: '20.35%', top: '0%', width: '59.29%', height: '41.25%', border: '1px solid rgba(255,255,255,0.8)' }} />
              <div style={{ position: 'absolute', left: '36.53%', top: '0%', width: '26.94%', height: '13.75%', border: '1px solid rgba(255,255,255,0.75)' }} />
              <div style={{ position: 'absolute', left: '50%', top: '27.5%', width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', transform: 'translate(-50%, -50%)' }} />
              <svg
                viewBox="0 0 68 40"
                preserveAspectRatio="none"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              >
                <path d="M26.69 16.5 A9.15 9.15 0 0 0 41.31 16.5" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.18" />
              </svg>
              {shotPoint ? (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(shotPoint.y / PITCH_WIDTH) * 100}%`,
                    top: `${(1 - shotPoint.x / XG_VISIBLE_LENGTH) * 100}%`,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: '#ef4444',
                    border: '2px solid white',
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              ) : null}
              <div style={{ position: 'absolute', left: 8, top: 6, color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600 }}>상대 골문</div>
              <div style={{ position: 'absolute', right: 8, top: 6, color: 'rgba(255,255,255,0.7)', fontSize: 10 }}>
                {isOnTargetShot ? '골문에서 도착 위치를 선택하세요' : '피치에서 슈팅 위치를 선택하세요'}
              </div>
              <div style={{ position: 'absolute', left: 8, bottom: 6, color: 'rgba(255,255,255,0.75)', fontSize: 10 }}>68m x 40m (rotated)</div>
            </div>
              </>}
            </div>

            <div className="muted">{isFutsal ? '풋살 20 × 20m 공격 하프의 골문 거리·각도로 Shot Threat(최대 0.800)를 추정합니다.' : '위치를 선택한 뒤 xG를 계산하거나 직접 입력하고 기록하세요.'}</div>
            {xgEstimateMeta ? <div className="muted">{xgEstimateMeta}</div> : null}
            {xgotEstimateMeta ? <div className="muted">{xgotEstimateMeta}</div> : null}

          </div>);
}

export function MatchRecentRecords({summary, canWrite, isResettingEvents, resetEvents, displayClockLabel}:{summary:any; canWrite:boolean; isResettingEvents:boolean; resetEvents:()=>void; displayClockLabel:(ms:number)=>string;}){
 return (<div className="card card-utility grid" style={{ minHeight: 280 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>최근 기록</h3>
              <button className="btn-danger" onClick={resetEvents} disabled={!canWrite || isResettingEvents}>
                {isResettingEvents ? '초기화 중…' : '기록 초기화'}
              </button>
            </div>
            <div
              className="grid fla-record-list"
              style={{
                height: 220,
                overflowY: 'auto',
                paddingRight: 4,
              }}
            >
              {(summary?.events || []).slice(0, 40).map((e: any) => (
                <div key={e.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    {e.type} {e.team}{' '}
                    {e.is_own_goal ? <strong style={{ color: '#f97316' }}>OG⚽</strong> : e.is_goal ? <strong style={{ color: '#22c55e' }}>GOAL⚽</strong> : ''}{' '}
                    @ {displayClockLabel(e.clock_ms)} {e.lane ? `lane=${e.lane}` : ''}{' '}
                    {e.is_own_goal ? '' : typeof e.xg === 'number' ? `xg=${e.xg}` : ''}{' '}
                    {e.is_own_goal ? '' : typeof e.xgot === 'number' ? `xgot=${e.xgot}` : ''}{' '}
                    {e.player_name ? `No.${e.player_number || '-'} ${e.player_name}` : ''}{' '}
                    {e.is_own_goal ? '' : e.is_on_target ? 'on-target' : ''}
                  </span>
                  <span className="muted">{formatCreatedAtKst(e.created_at)}</span>
                </div>
              ))}
            </div>
          </div>);
}

export function MatchPossessionTimeline({possessionLogs, downloadPossessionCsv, resetPossessionLogView}:{possessionLogs:string[]; downloadPossessionCsv:()=>void; resetPossessionLogView:()=>void;}){
 return (<div className="card card-utility grid" style={{ minHeight: 180, gap: 8 }}>
              <h3>점유 타임라인</h3>
              <div className="row" style={{ marginBottom: 8 }}>
                <button className="btn-success" onClick={downloadPossessionCsv} disabled={possessionLogs.length === 0}>CSV 다운로드</button>
                <button className="btn-secondary" onClick={resetPossessionLogView} disabled={possessionLogs.length === 0}>표시 기록 비우기</button>
              </div>
              <div
                className="grid fla-record-list"
                style={{
                  height: 105,
                  overflowY: 'auto',
                  paddingRight: 4,
                }}
              >
                {possessionLogs.length === 0 ? (
                  <span className="muted">아직 기록이 없습니다</span>
                ) : (
                  possessionLogs.map((line, idx) => (
                    <span key={`${idx}-${line}`} className="muted">{line}</span>
                  ))
                )}
              </div>
            </div>);
}

export function MatchFlowCard({isFutsal, dominanceChartData, dominanceXAxisTicks, formatDominanceTick, dominanceMeta, dominanceSeriesData}:{isFutsal:boolean; dominanceChartData:any[]; dominanceXAxisTicks:number[]; formatDominanceTick:(value:number)=>string; dominanceMeta:any; dominanceSeriesData:any[];}){
 return (<div className="card card-utility">
        <h3>경기 흐름 · {isFutsal ? '1분' : '3분'} 단위</h3>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer>
            <ComposedChart data={dominanceChartData}>
              <defs>
                <linearGradient id="dominanceFillSingle" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#f97316" stopOpacity={0.42} />
                  <stop offset="100%" stopColor="#f97316" stopOpacity={0.18} />
                </linearGradient>
                <linearGradient id="dominanceFillSingleAway" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity={0.42} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.10)" />
              <XAxis
                type="number"
                dataKey="minuteVal"
                ticks={dominanceXAxisTicks}
                tickFormatter={formatDominanceTick}
                domain={['dataMin', 'dataMax']}
              />
              <YAxis domain={[-1.2, 1.2]} ticks={[-1, -0.5, 0, 0.5, 1]} />
              <Tooltip />
              {dominanceMeta?.split_halves
                ? (
                    (dominanceMeta.breaks && dominanceMeta.breaks.length
                      ? dominanceMeta.breaks
                      : dominanceMeta.ht_chart_ms != null
                      ? [{ chart_ms: dominanceMeta.ht_chart_ms, label: 'HT' }]
                      : []) as Array<{ chart_ms: number; label: string }>
                  ).map((brk, brkIndex) => (
                    <ReferenceLine
                      key={`dominance-break-${brkIndex}-${brk.chart_ms}`}
                      x={Number(brk.chart_ms) / 60000}
                      stroke="#fbbf24"
                      strokeDasharray="6 4"
                      label={{ value: brk.label || 'HT', position: 'top', fill: '#fbbf24', fontSize: 12 }}
                    />
                  ))
                : null}
              {dominanceChartData.map((bin) => {
                const goalSummary = bin.annotations?.goal_summary;
                const hasHt = !dominanceMeta?.split_halves && Boolean(bin.annotations?.markers?.includes('HT'));
                const homeGoalLabel = goalSummary?.home ? `⚽ HOME${goalSummary.home > 1 ? ` x${goalSummary.home}` : ''}` : '';
                const awayGoalLabel = goalSummary?.away ? `⚽ AWAY${goalSummary.away > 1 ? ` x${goalSummary.away}` : ''}` : '';
                const homeGoalX = bin.minuteVal - (goalSummary?.home && goalSummary?.away ? 0.08 : 0);
                const awayGoalX = bin.minuteVal + (goalSummary?.home && goalSummary?.away ? 0.08 : 0);
                return (
                  <Fragment key={`dominance-annotation-${bin.minuteVal}`}>
                    {hasHt ? (
                      <ReferenceLine
                        x={bin.midpointMinuteVal}
                        stroke="#fbbf24"
                        strokeDasharray="6 4"
                        label={{ value: 'HT', position: 'top', fill: '#fbbf24', fontSize: 12 }}
                      />
                    ) : null}
                    {homeGoalLabel ? (
                      <>
                        <ReferenceLine
                          segment={[
                            { x: homeGoalX, y: 1 },
                            { x: homeGoalX, y: 0 },
                          ]}
                          stroke="#f97316"
                          strokeDasharray="4 4"
                          ifOverflow="extendDomain"
                        />
                        <ReferenceDot
                          x={homeGoalX}
                          y={1}
                          r={0}
                          fill="transparent"
                          stroke="transparent"
                          ifOverflow="extendDomain"
                          label={{
                            value: homeGoalLabel,
                            position: 'top',
                            fill: '#f97316',
                            fontSize: 12,
                            offset: hasHt ? 18 : 6,
                          }}
                        />
                      </>
                    ) : null}
                    {awayGoalLabel ? (
                      <>
                        <ReferenceLine
                          segment={[
                            { x: awayGoalX, y: 0 },
                            { x: awayGoalX, y: -1 },
                          ]}
                          stroke="#2563eb"
                          strokeDasharray="4 4"
                          ifOverflow="extendDomain"
                        />
                        <ReferenceDot
                          x={awayGoalX}
                          y={-1}
                          r={0}
                          fill="transparent"
                          stroke="transparent"
                          ifOverflow="extendDomain"
                          label={{
                            value: awayGoalLabel,
                            position: 'bottom',
                            fill: '#60a5fa',
                            fontSize: 12,
                            offset: 6,
                          }}
                        />
                      </>
                    ) : null}
                  </Fragment>
                );
              })}
              <Area type="monotone" data={dominanceSeriesData} dataKey="positiveDominance" baseValue={0} stroke="none" fill="url(#dominanceFillSingle)" connectNulls />
              <Area type="monotone" data={dominanceSeriesData} dataKey="negativeDominance" baseValue={0} stroke="none" fill="url(#dominanceFillSingleAway)" connectNulls />
              <Line type="monotone" data={dominanceSeriesData} dataKey="positiveDominance" stroke="#f97316" strokeWidth={3} dot={false} connectNulls />
              <Line type="monotone" data={dominanceSeriesData} dataKey="negativeDominance" stroke="#2563eb" strokeWidth={3} dot={false} connectNulls />
              <ReferenceLine y={0} stroke="#ffffff" strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>);
}
