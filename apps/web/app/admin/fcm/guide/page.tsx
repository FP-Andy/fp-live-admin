import type { ReactNode } from 'react';

const workflowRows = [
  ['01', 'FLA Dashboard', '경기 생성 후 종료된 경기를 Archive 처리합니다.'],
  ['02', 'Match Status', '경기와 팀을 열고 FPA 데이터, 대표 선수, 주요스탯을 저장합니다.'],
  ['03', 'Templates', '팀명 Regex와 카드 배경 이미지를 등록하고 호출 테스트로 매칭 결과를 확인합니다.'],
  ['04', 'Workspace', '대회와 라운드를 선택해 Ready 상태의 카드를 PNG 또는 ZIP으로 생성합니다.'],
] as const;

const statusRows = [
  ['Pending', '아직 해당 팀의 카드 정보가 저장되지 않은 상태입니다.', 'Match Status 상세에서 FPA 데이터 분석 후 제출합니다.'],
  ['Ready', '대표 선수, 선수 이름, 주요스탯이 저장된 상태입니다.', 'Workspace에서 개별 생성 또는 일괄 생성할 수 있습니다.'],
  ['Template Missing', '팀명에 매칭되는 배경 템플릿이 없습니다.', 'Templates에서 Regex와 이미지를 등록합니다.'],
  ['Generated', '생성 버튼으로 PNG 또는 ZIP 다운로드가 시작된 상태입니다.', '다운로드 파일을 확인하고 필요한 경우 Match Status에서 스탯을 다시 저장합니다.'],
] as const;

const templateRows = [
  ['템플릿 이름', '관리 화면에서 구분할 이름입니다.', '예: 당진 기본 템플릿'],
  ['호출 Regex', '팀명과 매칭할 정규식입니다. 대소문자는 구분하지 않습니다.', '예: 당진|당진시민'],
  ['우선순위', '숫자가 낮을수록 먼저 검사됩니다.', '특수 템플릿 10, 기본 템플릿 100'],
  ['사용 여부', 'Inactive 상태는 매칭에서 제외됩니다.', '시즌 종료 템플릿을 잠시 비활성화할 때 사용'],
] as const;

const statRows = [
  ['자동 후보', 'FPA 데이터 분석 결과에서 선수별 주요 후보가 표시됩니다.', '후보 버튼을 눌러 최대 5개 선택'],
  ['커스텀 스탯', '특정 선수에게 필요한 문구를 직접 입력합니다.', '예: 압박 회피 후 전진 패스 4회'],
  ['선수 이름', '카드에 표시될 선수 이름입니다.', '번호만 자동으로 잡히므로 이름은 확인 후 입력'],
  ['팀 선택', 'HOME/AWAY 각각 별도로 저장됩니다.', '양 팀 모두 Ready가 필요하면 두 팀을 각각 제출'],
] as const;

const troubleshootingRows = [
  ['카드 생성 버튼이 비활성화됨', '현재 라운드에 Ready 항목이 없거나 해당 row가 Pending입니다.'],
  ['ZIP에 일부 팀만 들어감', 'Ready여도 템플릿이 없거나 이미지 생성 중 오류가 난 팀은 제외될 수 있습니다.'],
  ['템플릿이 예상과 다르게 잡힘', '우선순위가 낮은 숫자인 템플릿이 먼저 매칭됩니다. Regex를 더 구체적으로 조정합니다.'],
  ['FPA 데이터 업로드 후 선수가 적게 보임', '팀명이 매치의 HOME/AWAY 이름과 다르면 전체 선수 pool에서 고를 수 있습니다.'],
  ['카드 문구를 바꾸고 싶음', 'Match Status 상세에서 스탯을 다시 선택하거나 커스텀 스탯을 추가한 뒤 제출합니다.'],
] as const;

function GuideTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <div className="fcm-guide-table-wrap">
      <table className="fcm-guide-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join('-')}>
              {row.map((cell, index) => (
                <td key={`${row[0]}-${index}`}>
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

function GuideList({ items, ordered = false }: { items: ReactNode[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';

  return (
    <Tag className="fcm-guide-list">
      {items.map((item, index) => (
        <li key={index}>
          {item}
        </li>
      ))}
    </Tag>
  );
}

export default function FcmGuidePage() {
  return (
    <main className="page-stack fcm-guide-page">
      <section className="card card-hero page-hero fcm-guide-hero">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">FinePlay Card Marker</div>
            <h2 style={{ margin: '6px 0 0' }}>Guide</h2>
          </div>
          <span className="status-pill tech">FCM</span>
        </div>
        <p className="field-help" style={{ margin: 0, maxWidth: '78ch' }}>
          FCM은 archived match의 FPA 데이터에서 대표 선수와 주요스탯을 정리하고, 팀별 배경 템플릿을 매칭해
          카드 이미지를 생성하는 작업 공간입니다.
        </p>
        <div className="fcm-guide-overview">
          <div>
            <span>시작점</span>
            <strong>Archived Match</strong>
          </div>
          <div>
            <span>완료 기준</span>
            <strong>Ready + Template</strong>
          </div>
          <div>
            <span>결과물</span>
            <strong>PNG / ZIP</strong>
          </div>
        </div>
      </section>

      <section className="card card-utility fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Quick Start</div>
            <h3 style={{ margin: 0 }}>전체 작업 흐름</h3>
          </div>
        </div>
        <div className="fcm-guide-flow">
          {workflowRows.map(([step, title, description]) => (
            <article className="fcm-guide-step" key={step}>
              <span>{step}</span>
              <strong>{title}</strong>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card card-utility fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Match Status</div>
            <h3 style={{ margin: 0 }}>경기별 제출</h3>
          </div>
        </div>
        <GuideList
          ordered
          items={[
            '대회와 라운드를 선택한 뒤 Archived Match Pool에서 경기를 엽니다.',
            'HOME/AWAY 팀을 선택하고 FPA 엑셀 파일을 업로드합니다.',
            '매치 분석을 실행한 뒤 선수 번호와 선수 이름을 확인합니다.',
            '자동 후보 또는 커스텀 스탯으로 주요스탯 최대 5개를 구성합니다.',
            '5개 스탯 제출을 누르면 해당 팀 row가 Ready 상태가 됩니다.',
          ]}
        />
      </section>

      <section className="card card-utility fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Status</div>
            <h3 style={{ margin: 0 }}>상태 의미</h3>
          </div>
        </div>
        <div className="fcm-guide-status-list">
          {statusRows.map(([status, meaning, next]) => (
            <article className="fcm-guide-status" key={status}>
              <strong>{status}</strong>
              <p>{meaning}</p>
              <span>{next}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="card card-utility fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Templates</div>
            <h3 style={{ margin: 0 }}>팀별 배경 템플릿</h3>
          </div>
        </div>
        <p className="field-help" style={{ margin: 0 }}>
          카드 생성은 등록된 Regex 템플릿을 먼저 확인하고, 없으면 기존 파일명 기반 템플릿을 fallback으로 시도합니다.
        </p>
        <GuideTable headers={['항목', '설명', '예시']} rows={templateRows} />
      </section>

      <section className="card card-utility fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Regex Tips</div>
            <h3 style={{ margin: 0 }}>호출식 작성</h3>
          </div>
        </div>
        <GuideList
          items={[
            <><code>당진</code> 팀명에 당진이 포함되면 매칭됩니다.</>,
            <><code>당진|당진시민</code> 둘 중 하나가 포함되면 매칭됩니다.</>,
            <><code>^포천$</code> 팀명이 정확히 포천일 때만 매칭됩니다.</>,
            <><code>시흥.*축구단</code> 시흥으로 시작하고 뒤에 축구단이 포함되는 팀명을 매칭합니다.</>,
            '호출 규칙 미리보기에서 팀명을 입력하면 실제 선택될 템플릿 이미지가 표시됩니다.',
          ]}
        />
      </section>

      <section className="card card-utility fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Stats</div>
            <h3 style={{ margin: 0 }}>주요스탯 선택</h3>
          </div>
        </div>
        <GuideTable headers={['방식', '설명', '메모']} rows={statRows} />
      </section>

      <section className="card card-utility fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Workspace</div>
            <h3 style={{ margin: 0 }}>카드 생성과 다운로드</h3>
          </div>
        </div>
        <GuideList
          ordered
          items={[
            '대회 선택과 라운드 선택으로 생성 대상 pool을 좁힙니다.',
            'Ready row의 생성 버튼은 해당 팀 카드 1장만 PNG로 다운로드합니다.',
            '카드 생성 + 다운로드 버튼은 현재 대회/라운드의 생성 가능한 카드들을 ZIP으로 다운로드합니다.',
            'ZIP 생성 시 템플릿이 없거나 생성에 실패한 팀은 제외될 수 있으므로 다운로드 후 파일 수를 확인합니다.',
            '스탯이나 선수명을 수정해야 하면 Match Status 상세로 돌아가 다시 제출한 뒤 생성합니다.',
          ]}
        />
      </section>

      <section className="card card-panel fcm-guide-section">
        <div className="section-heading">
          <div>
            <div className="sidebar-eyebrow">Troubleshooting</div>
            <h3 style={{ margin: 0 }}>자주 막히는 상황</h3>
          </div>
        </div>
        <GuideTable headers={['상황', '확인할 것']} rows={troubleshootingRows} />
      </section>
    </main>
  );
}
