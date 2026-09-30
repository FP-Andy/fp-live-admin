// Report display names and point colors supplied in k-league-club-names-2026.md (2026-09-30).
// Includes image-derived approximate colors; these are not all official HEX values.
export const FUTSAL_CLUBS = [
  {
    "short": "강원",
    "name": "강원 FC",
    "colors": [
      "#DD5828",
      "#FDB813",
      "#006058",
      "#00302B"
    ],
    "aliases": []
  },
  {
    "short": "광주",
    "name": "광주 FC",
    "colors": [
      "#F5BC00",
      "#5F0E0D"
    ],
    "aliases": []
  },
  {
    "short": "김천",
    "name": "김천 상무",
    "colors": [
      "#B81C22",
      "#002648"
    ],
    "aliases": [
      "김천상무",
      "김천상무FC"
    ]
  },
  {
    "short": "대전",
    "name": "대전 하나 시티즌",
    "colors": [
      "#992941",
      "#007D6F"
    ],
    "aliases": []
  },
  {
    "short": "부천",
    "name": "부천 FC",
    "colors": [
      "#A32526",
      "#000000"
    ],
    "aliases": [
      "부천FC1995"
    ]
  },
  {
    "short": "서울",
    "name": "FC 서울",
    "colors": [
      "#D6000F",
      "#000000"
    ],
    "aliases": []
  },
  {
    "short": "안양",
    "name": "FC 안양",
    "colors": [
      "#4A227A",
      "#C8A05E"
    ],
    "aliases": []
  },
  {
    "short": "울산",
    "name": "울산 HD",
    "colors": [
      "#004098",
      "#FFFFFF",
      "#FDB813"
    ],
    "aliases": [
      "울산현대"
    ]
  },
  {
    "short": "인천",
    "name": "인천 유나이티드",
    "colors": [
      "#036EB8",
      "#231815"
    ],
    "aliases": []
  },
  {
    "short": "전북",
    "name": "전북 현대",
    "colors": [
      "#22533D"
    ],
    "aliases": [
      "전북현대모터스"
    ]
  },
  {
    "short": "제주",
    "name": "제주 SK",
    "colors": [
      "#ED7600"
    ],
    "aliases": [
      "제주유나이티드"
    ]
  },
  {
    "short": "포항",
    "name": "포항 스틸러스",
    "colors": [
      "#EA5442",
      "#000000"
    ],
    "aliases": []
  },
  {
    "short": "경남",
    "name": "경남 FC",
    "colors": [
      "#E83827",
      "#FFD404",
      "#271800"
    ],
    "aliases": []
  },
  {
    "short": "김포",
    "name": "김포 FC",
    "colors": [
      "#DFFCA8"
    ],
    "aliases": []
  },
  {
    "short": "김해",
    "name": "김해 FC",
    "colors": [
      "#C40317",
      "#000000"
    ],
    "aliases": [
      "김해시청"
    ]
  },
  {
    "short": "대구",
    "name": "대구 FC",
    "colors": [
      "#9FD1F1"
    ],
    "aliases": []
  },
  {
    "short": "부산",
    "name": "부산 아이파크",
    "colors": [
      "#BF1F2B",
      "#FFFFFF",
      "#9F9E9F"
    ],
    "aliases": []
  },
  {
    "short": "서울E",
    "name": "서울 이랜드",
    "colors": [
      "#000430"
    ],
    "aliases": [
      "서울이랜드",
      "서울이랜드FC"
    ]
  },
  {
    "short": "성남",
    "name": "성남 FC",
    "colors": [
      "#221E1F"
    ],
    "aliases": []
  },
  {
    "short": "수원 삼성",
    "name": "수원 삼성",
    "colors": [
      "#0058A7",
      "#FFFFFF",
      "#E83534"
    ],
    "aliases": [
      "수원삼성블루윙즈"
    ]
  },
  {
    "short": "수원 FC",
    "name": "수원 FC",
    "colors": [
      "#011F56",
      "#C31327"
    ],
    "aliases": []
  },
  {
    "short": "안산",
    "name": "안산 그리너스",
    "colors": [
      "#009C7D",
      "#002A3A",
      "#FFDF2A"
    ],
    "aliases": []
  },
  {
    "short": "용인",
    "name": "용인 FC",
    "colors": [
      "#A6093D",
      "#5BC2E7"
    ],
    "aliases": []
  },
  {
    "short": "전남",
    "name": "전남 드래곤즈",
    "colors": [
      "#E3C223"
    ],
    "aliases": []
  },
  {
    "short": "천안",
    "name": "천안 시티 FC",
    "colors": [
      "#5EB3E4"
    ],
    "aliases": []
  },
  {
    "short": "충남아산",
    "name": "충남아산 FC",
    "colors": [
      "#093D91"
    ],
    "aliases": []
  },
  {
    "short": "충북청주",
    "name": "충북청주 FC",
    "colors": [
      "#1C235A",
      "#E8383D"
    ],
    "aliases": [
      "청주"
    ]
  },
  {
    "short": "파주",
    "name": "파주 프론티어",
    "colors": [
      "#243C96",
      "#EE92B8"
    ],
    "aliases": [
      "파주시민",
      "파주프런티어"
    ]
  },
  {
    "short": "화성",
    "name": "화성 FC",
    "colors": [
      "#E74E0F"
    ],
    "aliases": []
  }
] as const;
const key=(name:string)=>name.normalize('NFC').toLowerCase().replace(/[\s·._-]/g,'');
export function futsalClub(name:string){const value=key(name);return FUTSAL_CLUBS.find(c=>[c.short,c.name,...c.aliases].some(n=>key(n)===value||key('FC'+n)===value||key(n+'FC')===value));}
export const clubName=(name:string)=>futsalClub(name)?.name||name;
export const sameClub=(a:string,b:string)=>!!a&&!!b&&(key(a)===key(b)||!!futsalClub(a)&&futsalClub(a)===futsalClub(b));
