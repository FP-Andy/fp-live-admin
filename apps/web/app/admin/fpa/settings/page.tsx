const actionGroups = [
  {
    title: '슈팅',
    rows: [
      ['ddd', 'Goal', '1개', '골'],
      ['dd', 'Shot On Target', '1개', '유효 슈팅'],
      ['d', 'Shot', '1개', '빗나감 포함 슈팅'],
      ['db', 'Blocked Shot', '1개', '블락된 슈팅'],
    ],
  },
  {
    title: '패스와 찬스 메이킹',
    rows: [
      ['ss', 'Pass (Success)', '2개', '패스 성공'],
      ['s', 'Pass (Fail)', '2개', '패스 실패'],
      ['zz', 'Assist', '2개', '어시스트'],
      ['z', 'Key Pass', '2개', '키 패스'],
      ['cc', 'Cross (Success)', '2개', '크로스 성공'],
      ['c', 'Cross (Fail)', '2개', '크로스 실패'],
    ],
  },
  {
    title: '공격 플레이',
    rows: [
      ['ee', 'Breakthrough', '2개', '돌파'],
      ['rr', 'Dribble', '1개', '드리블'],
      ['gp', 'Gain', '1개', '볼 획득'],
      ['m', 'Miss', '1개', '컨트롤 미스'],
      ['tr', 'Throw-in', '2개', '스로인'],
      ['st', 'Sprint', '2개', '스프린트'],
    ],
  },
  {
    title: '수비와 기타',
    rows: [
      ['aa', 'Tackle', '1개', '태클'],
      ['q', 'Intercept', '1개', '인터셉트'],
      ['qq', 'Acquisition', '1개', '볼 탈취'],
      ['w', 'Clear', '1개', '클리어'],
      ['ww', 'Cutout', '1개', '차단'],
      ['qw', 'Block', '1개', '블락'],
      ['v / vv / sv', 'Goalkeeper Actions', '1개', '캐칭, 펀칭, 세이브'],
      ['bb / b', 'Duel', '1개', '경합 성공 / 실패'],
      ['f / ff', 'Foul', '1개', '파울 / 피파울'],
      ['o', 'Offside', '1개', '오프사이드'],
      ['t', 'Touch', '1개', '위치 기록'],
    ],
  },
] as const;

const tagRows = [
  ['k', 'Key', '키패스'],
  ['a', 'Assist', '어시스트'],
  ['h', 'Header', '헤더'],
  ['r', 'Aerial', '공중볼 경합'],
  ['w', 'Suffered', '파울 당함'],
  ['n', 'In-box', '박스 안'],
  ['u', 'Out-box', '박스 밖'],
  ['p', 'Progressive', '진전 패스'],
  ['c', 'Counter Attack', '역습'],
  ['sw', 'Switch', '사이드 전환'],
  ['wf', 'Weak Foot', '약발'],
  ['ft', 'First Time', '원터치'],
] as const;

const autoTags = [
  ['Success', '액션 코드가 2번 반복될 때', '예: ss, cc, dd, ddd'],
  ['Fail', '액션 코드가 1번일 때', '예: s, c, d'],
  ['Progressive', '패스가 전진 조건을 충족할 때', '진전 패스 자동 부여'],
  ['In-box', '이벤트가 박스 안에서 발생할 때', '슈팅/패스 위치 기준'],
  ['Out-box', '슈팅이 박스 밖에서 발생할 때', '중거리 시도 구분'],
] as const;

const examples = [
  ['10ss8', '10번 선수가 8번 선수에게 패스 성공', '좌표 2개, 자동 태그 Success'],
  ['7ss9.k', '7번 선수가 9번 선수에게 키패스', '좌표 2개, Success + Key'],
  ['11ddd.wf', '11번 선수가 약발로 골', '좌표 1개, Success + Weak Foot'],
  ['9ddd.h', '9번 선수가 헤더 골', '좌표 1개, Success + Header'],
  ['3c', '3번 선수가 크로스를 시도했지만 실패', '좌표 2개, Fail'],
  ['10ddd.c.wf', '10번 선수가 역습 상황에서 약발 골', 'Counter Attack + Weak Foot'],
] as const;

const scoringRows = [
  ['Passing', '(성공률 * 0.8) + (전진패스 * 1.5) + (키패스 * 2.5) + (어시스트 * 5) + (박스안패스 * 3) - (패스미스 * 0.5)'],
  ['Shooting', '((득점 - xG) * 10) + (xG * 15) + (헤더득점 * 5) + (중거리/박스밖득점 * 3)'],
  ['Cross', '(성공률 * 0.7) + (ln(성공개수) * 3) + (중앙/박스안 연결 * 2.5)'],
  ['Dribbling', '(돌파성공 * 3) - ((드리블실패 + 미스) * 1) + (피파울 * 0.8)'],
  ['TAC', '(태클성공 * 2) - (태클실패 * 1) + (인터셉트 * 1.5) + (블락 * 1.2) + (클리어 * 1)'],
  ['DRV', '(유효드리블거리합 * 0.15) - (드리블장소실패 * 2)'],
  ['BLD', '자기진영 패스 점수 합 - (자기진영 패스미스 * 2)'],
  ['SAV', '((피유효슈팅xG - 실점) * 10) + (선방xG * 10) + (캐칭 * 2)'],
  ['HED', '(헤더유효슈팅 * 3) + (헤더득점 * 2) + (공중볼승리 * 2) + (헤더클리어 * 1) - (공중볼패배 * 1.5)'],
  ['PAC', '(스프린트횟수 * 1) + (총스프린트거리 * 0.1)'],
] as const;

function GuideTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--muted)',
                  fontWeight: 600,
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join('-')}>
              {row.map((cell, index) => (
                <td
                  key={`${row[0]}-${index}`}
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    verticalAlign: 'top',
                    lineHeight: 1.5,
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GuideList({ items }: { items: string[] }) {
  return (
    <div className="grid" style={{ gap: 10 }}>
      {items.map((item) => (
        <div className="muted" key={item}>
          {item}
        </div>
      ))}
    </div>
  );
}

export default function FpaSettingsPage() {
  return (
    <main className="page-stack">
      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">FPA Workspace</div>
            <h2 style={{ margin: 0 }}>Code Guide</h2>
          </div>
          <span className="status-pill tech">Manual</span>
        </div>
        <div className="muted">
          원본 FPA의 사용 설명서와 통계 산출 매뉴얼을 Fine Play Console 안에서 바로 참고할 수 있게 정리한 페이지입니다. 실시간 입력 규칙, 스탯 코드 문법, 자동 태그, 단축키, 주요 점수 산식까지 한 화면에서 확인할 수 있습니다.
        </div>
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Quick Start</div>
            <h3 style={{ margin: 0 }}>입력 전 체크</h3>
          </div>
        </div>
        <GuideList
          items={[
            'Match ID, Home Team, Away Team을 먼저 입력합니다.',
            'Half, Team, Direction을 현재 경기 상황에 맞게 확인합니다.',
            '축구장 좌표는 105 x 68 기준이며 원점은 좌하단입니다.',
            'Home/Away를 바꾸면 Direction도 같이 뒤집히는 현재 콘솔 동작을 전제로 입력합니다.',
            '1점 액션은 좌표 1개, 패스/크로스/돌파/스로인/스프린트 계열은 좌표 2개가 필요합니다.',
          ]}
        />
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Input Grammar</div>
            <h3 style={{ margin: 0 }}>스탯 코드 형식</h3>
          </div>
        </div>
        <div className="muted">
          기본 입력 형식은 `선수번호 + 액션코드 + 수신선수번호 + . + 태그코드1.태그코드2...` 입니다.
        </div>
        <GuideList
          items={[
            '`10ss8.k` → 10번 선수가 8번 선수에게 패스 성공, Key 태그 추가',
            '`9dd.wf` → 9번 선수가 약발로 유효 슈팅',
            '`7d` → 7번 선수가 슈팅',
            '수신 선수가 없는 1점 액션은 선수번호와 액션코드만으로 입력 가능합니다.',
          ]}
        />
      </section>

      {actionGroups.map((group) => (
        <section className="card card-utility grid" key={group.title}>
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Action Codes</div>
              <h3 style={{ margin: 0 }}>{group.title}</h3>
            </div>
          </div>
          <GuideTable
            headers={['코드', '액션', '좌표 개수', '설명']}
            rows={group.rows}
          />
        </section>
      ))}

      <section className="grid hero-form-grid" style={{ alignItems: 'start' }}>
        <article className="card card-utility grid">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Manual Tags</div>
              <h3 style={{ margin: 0 }}>수동 태그</h3>
            </div>
          </div>
          <GuideTable headers={['코드', '태그', '설명']} rows={tagRows} />
        </article>

        <article className="card card-utility grid">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Auto Tags</div>
              <h3 style={{ margin: 0 }}>자동 태그 규칙</h3>
            </div>
          </div>
          <GuideTable headers={['태그', '조건', '메모']} rows={autoTags} />
        </article>
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Examples</div>
            <h3 style={{ margin: 0 }}>스탯 입력 예시</h3>
          </div>
        </div>
        <GuideTable headers={['입력', '의미', '메모']} rows={examples} />
      </section>

      <section className="grid hero-form-grid" style={{ alignItems: 'start' }}>
        <article className="card card-utility grid">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Shortcuts</div>
              <h3 style={{ margin: 0 }}>키보드 단축키</h3>
            </div>
          </div>
          <GuideList
            items={[
              '`Enter` : Stat Input 제출',
              '`ArrowUp`, `ArrowRight` : 시간 +1분',
              '`ArrowDown`, `ArrowLeft` : 시간 -1분',
              '축구장 좌클릭 : 좌표 추가',
              '축구장 우클릭 : 마지막 좌표 제거',
            ]}
          />
        </article>

        <article className="card card-utility grid">
          <div className="section-heading">
            <div>
              <div className="sidebar-eyebrow">Operator Notes</div>
              <h3 style={{ margin: 0 }}>운영 팁</h3>
            </div>
          </div>
          <GuideList
            items={[
              '패스 계열은 반드시 시작점과 끝점 순서로 찍습니다.',
              '방향이 Left인 경우 분석 엔진이 내부적으로 좌표를 반전해 정규화합니다.',
              '같은 파일로 재분석과 시각화를 이어가려면 File Analyzer를 먼저 사용하는 것이 가장 빠릅니다.',
              '업로드 분석은 반드시 `Data` 시트가 있는 파일을 기준으로 동작합니다.',
            ]}
          />
        </article>
      </section>

      <section className="card card-panel grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Scoring Logic</div>
            <h3 style={{ margin: 0 }}>주요 점수 산식</h3>
          </div>
        </div>
        <div className="muted">
          각 점수는 Raw Score 계산 후 시그모이드 기반으로 0~100 범위 점수로 변환됩니다. 데이터가 거의 없을 때도 중립값 근처에서 시작하도록 설계되어 있습니다.
        </div>
        <GuideTable headers={['항목', '핵심 공식']} rows={scoringRows} />
      </section>

      <section className="card card-utility grid">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Advanced Scores</div>
            <h3 style={{ margin: 0 }}>고급 지표</h3>
          </div>
        </div>
        <GuideList
          items={[
            'FST: 패스와 돌파 성공률 기반의 볼 키핑 안정성',
            'OFF: 받은 패스, 찬스 창출, 오프사이드 등을 반영한 오프더볼 움직임',
            'DEC: 원터치 플레이 성공률 기반의 판단 속도와 정확성',
          ]}
        />
      </section>
    </main>
  );
}
