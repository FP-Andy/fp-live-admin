// Paired report labels: role categories for readers, not an exact tactical equivalence.
export const REPORT_ROLES=[
 {value:'GK',football:'GK · 골키퍼',futsal:'GOLEIRO · 골레이로',short:'GK · GOLEIRO',focus:'골문과 동료 사이의 연결',next:'공이 이동할 때 골문과 동료를 함께 보고, 공을 잡은 뒤 연결할 통로를 준비해 봐요.'},
 {value:'DF',football:'DF · 수비수',futsal:'FIXO · 픽소',short:'DF · FIXO',focus:'뒤쪽 공간을 지키며 앞선과 잇는 연결',next:'전진한 뒤에는 뒤쪽 공간과 동료 간격을 함께 살펴봐요. 다음 수비와 연결을 같이 준비할 수 있어요.'},
 {value:'MF',football:'MF · 미드필더',futsal:'ALA · 알라',short:'MF · ALA',focus:'중앙과 측면을 오가며 동료를 잇는 연결',next:'공을 연결한 뒤 옆 공간이나 반대편을 한 번 더 살펴봐요. 동료가 다시 연결할 선택지가 늘어날 거예요.'},
 {value:'FW',football:'FW · 공격수',futsal:'PIVO · 피보',short:'FW · PIVO',focus:'전방에서 공을 받고 마무리를 준비하는 움직임',next:'공을 받기 전 골문과 동료의 위치를 함께 살펴봐요. 직접 마무리할 때와 연결할 때의 선택을 준비해 봐요.'},
] as const;
export function reportRole(position:string){return REPORT_ROLES.find(r=>r.value===position||r.short.split(' · ')[1]===position);}
