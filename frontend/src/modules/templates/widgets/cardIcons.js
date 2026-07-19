// 카드 위젯 아이콘 허용셋 — 저장 이름(kebab-case) → lucide 컴포넌트 + 한글 라벨.
//
// ⚠️ 이 목록은 backend `app/widgets/registry.py` 의 `_CARD_ICONS` 와 **쌍**이다.
// 백엔드는 enum 으로 저장을 거부하고, 여기는 실제로 그릴 수 있는 것을 정한다.
// 한쪽에만 추가하면: 백엔드만 → 저장은 되는데 화면에 안 그려짐(조용히 무시),
// 프론트만 → 저장이 422 로 거부됨. **반드시 함께** 고칠 것.
// 목록 동기화는 `tests/test_widgets_card.py` 가 개수로 잡아 준다.
//
// 임의의 lucide 이름(3,900여 개)을 다 열지 않는 이유: (1) 정적 import 해야 번들에
// 들어가고, (2) 고를 수 없을 만큼 많으면 피커가 건초더미가 되며, (3) PPTX/DOCX
// export 가 같은 셋만 래스터화한다. 대신 **전자제품 R&D** 도메인에 맞춰 넓게 잡았다.
import {
  Activity, AlertCircle, Antenna, AudioWaveform, Award,
  BadgeCheck, Battery, BatteryCharging, BatteryWarning, Beaker, Binary, Bluetooth, Bolt,
  Book, Boxes, Bug, Building2,
  Calendar, CalendarClock, Camera, ChartColumn, ChartLine, ChartPie, CircleCheck, CircuitBoard,
  ClipboardCheck, ClipboardList, Clock, Cloud, Code, Cog, Coins, Component, Container, Cpu,
  Database, Droplet,
  Eye, Factory, Fan, FileCheck, FileText, Filter, Fingerprint, Flag, Flame, FlaskConical,
  Gauge, GitBranch,
  Hammer, Handshake, HardDrive, Headphones, History,
  Info, Laptop, Layers, Leaf, Lightbulb, Link, ListChecks, Lock,
  Magnet, MemoryStick, Microchip, Microscope, Milestone, Mic, Monitor,
  Network, Nfc, Package, Plug, PlugZap, Power, Puzzle,
  Radar, Radiation, Radio, RadioTower, RefreshCw, Recycle, Ruler,
  Satellite, Scale, Scan, Search, Server, Settings, Share2, Shield, ShieldAlert, ShieldCheck,
  Signal, Smartphone, Snowflake, Sparkles, Speaker,
  Tablet, Target, Terminal, TestTube, Thermometer, Timer, TrendingDown, TrendingUp,
  TriangleAlert, Truck, Tv,
  User, Users,
  Volume2, Warehouse, Waves, Wifi, Wind, Workflow, Wrench, Zap,
} from 'lucide-react'

/**
 * 아이콘 정의. `name` 이 저장값, `label` 이 피커·검색에 쓰는 한글 이름,
 * `group` 은 피커의 묶음. 순서 = 피커 노출 순서.
 * `keywords` 는 한글 라벨로는 안 잡히는 검색어 보강(선택).
 */
export const CARD_ICON_DEFS = [
  // ── 반도체 · 회로 ────────────────────────────────────────────────
  { name: 'cpu', label: '반도체', group: '반도체·회로', Cmp: Cpu, keywords: '칩 프로세서 소자' },
  { name: 'microchip', label: '칩', group: '반도체·회로', Cmp: Microchip },
  { name: 'circuit-board', label: '기판', group: '반도체·회로', Cmp: CircuitBoard, keywords: 'pcb 회로' },
  { name: 'component', label: '부품', group: '반도체·회로', Cmp: Component },
  { name: 'memory', label: '메모리', group: '반도체·회로', Cmp: MemoryStick },
  { name: 'binary', label: '이진데이터', group: '반도체·회로', Cmp: Binary, keywords: '디지털 신호' },
  { name: 'puzzle', label: '모듈', group: '반도체·회로', Cmp: Puzzle, keywords: '조합' },

  // ── 전원 · 전력 ──────────────────────────────────────────────────
  { name: 'battery', label: '배터리', group: '전원·전력', Cmp: Battery },
  { name: 'battery-charging', label: '충전', group: '전원·전력', Cmp: BatteryCharging },
  { name: 'battery-warning', label: '배터리 경고', group: '전원·전력', Cmp: BatteryWarning },
  { name: 'power', label: '전원', group: '전원·전력', Cmp: Power },
  { name: 'plug', label: '플러그', group: '전원·전력', Cmp: Plug },
  { name: 'plug-zap', label: '급속충전', group: '전원·전력', Cmp: PlugZap },
  { name: 'zap', label: '전기', group: '전원·전력', Cmp: Zap, keywords: '번개 순간' },
  { name: 'bolt', label: '전압', group: '전원·전력', Cmp: Bolt },

  // ── 통신 · 무선 ──────────────────────────────────────────────────
  { name: 'wifi', label: '무선', group: '통신·무선', Cmp: Wifi, keywords: '와이파이' },
  { name: 'bluetooth', label: '블루투스', group: '통신·무선', Cmp: Bluetooth },
  { name: 'nfc', label: 'NFC', group: '통신·무선', Cmp: Nfc },
  { name: 'antenna', label: '안테나', group: '통신·무선', Cmp: Antenna },
  { name: 'signal', label: '신호세기', group: '통신·무선', Cmp: Signal },
  { name: 'radio', label: '전파', group: '통신·무선', Cmp: Radio, keywords: 'rf' },
  { name: 'radio-tower', label: '기지국', group: '통신·무선', Cmp: RadioTower },
  { name: 'satellite', label: '위성', group: '통신·무선', Cmp: Satellite },
  { name: 'network', label: '네트워크', group: '통신·무선', Cmp: Network, keywords: '연결 망' },
  { name: 'share', label: '연계', group: '통신·무선', Cmp: Share2, keywords: '공유 분기' },

  // ── 제품 · 기기 ──────────────────────────────────────────────────
  { name: 'smartphone', label: '스마트폰', group: '제품·기기', Cmp: Smartphone },
  { name: 'tablet', label: '태블릿', group: '제품·기기', Cmp: Tablet },
  { name: 'laptop', label: '노트북', group: '제품·기기', Cmp: Laptop },
  { name: 'monitor', label: '모니터', group: '제품·기기', Cmp: Monitor, keywords: '디스플레이 화면' },
  { name: 'tv', label: 'TV', group: '제품·기기', Cmp: Tv },
  { name: 'camera', label: '카메라', group: '제품·기기', Cmp: Camera, keywords: '이미지센서' },
  { name: 'mic', label: '마이크', group: '제품·기기', Cmp: Mic },
  { name: 'speaker', label: '스피커', group: '제품·기기', Cmp: Speaker },
  { name: 'headphones', label: '헤드폰', group: '제품·기기', Cmp: Headphones },
  { name: 'volume', label: '음량', group: '제품·기기', Cmp: Volume2, keywords: '소리' },

  // ── 계측 · 시험 ──────────────────────────────────────────────────
  { name: 'gauge', label: '계측', group: '계측·시험', Cmp: Gauge, keywords: '게이지 측정' },
  { name: 'thermometer', label: '온도', group: '계측·시험', Cmp: Thermometer, keywords: '발열' },
  { name: 'fan', label: '방열', group: '계측·시험', Cmp: Fan, keywords: '냉각 팬' },
  { name: 'snowflake', label: '저온', group: '계측·시험', Cmp: Snowflake },
  { name: 'flame', label: '고온', group: '계측·시험', Cmp: Flame, keywords: '발화' },
  { name: 'droplet', label: '습도', group: '계측·시험', Cmp: Droplet, keywords: '방수 수분' },
  { name: 'wind', label: '기류', group: '계측·시험', Cmp: Wind },
  { name: 'waves', label: '진동', group: '계측·시험', Cmp: Waves, keywords: '파형' },
  { name: 'audio-waveform', label: '소음', group: '계측·시험', Cmp: AudioWaveform, keywords: '음향 파형' },
  { name: 'magnet', label: '자기', group: '계측·시험', Cmp: Magnet, keywords: 'emc 전자기' },
  { name: 'radiation', label: '방사', group: '계측·시험', Cmp: Radiation, keywords: 'emi 노이즈' },
  { name: 'ruler', label: '치수', group: '계측·시험', Cmp: Ruler },
  { name: 'scale', label: '중량', group: '계측·시험', Cmp: Scale, keywords: '무게 저울' },
  { name: 'timer', label: '수명', group: '계측·시험', Cmp: Timer, keywords: '내구 시간' },
  { name: 'radar', label: '탐지', group: '계측·시험', Cmp: Radar, keywords: '센서' },
  { name: 'scan', label: '검사', group: '계측·시험', Cmp: Scan },
  { name: 'fingerprint', label: '인식', group: '계측·시험', Cmp: Fingerprint, keywords: '지문 센서' },
  { name: 'microscope', label: '분석', group: '계측·시험', Cmp: Microscope, keywords: '현미경' },
  { name: 'flask', label: '실험', group: '계측·시험', Cmp: FlaskConical, keywords: '플라스크' },
  { name: 'test-tube', label: '시험', group: '계측·시험', Cmp: TestTube, keywords: '시험관' },
  { name: 'beaker', label: '시료', group: '계측·시험', Cmp: Beaker, keywords: '비커' },

  // ── 품질 · 판정 ──────────────────────────────────────────────────
  { name: 'check-circle', label: '합격', group: '품질·판정', Cmp: CircleCheck, keywords: '완료 확인 통과' },
  { name: 'badge-check', label: '인증', group: '품질·판정', Cmp: BadgeCheck, keywords: '검증 배지' },
  { name: 'alert-triangle', label: '경고', group: '품질·판정', Cmp: TriangleAlert, keywords: '주의 위험' },
  { name: 'alert-circle', label: '이상', group: '품질·판정', Cmp: AlertCircle },
  { name: 'bug', label: '결함', group: '품질·판정', Cmp: Bug, keywords: '불량 버그' },
  { name: 'shield', label: '안전', group: '품질·판정', Cmp: Shield },
  { name: 'shield-check', label: '검증완료', group: '품질·판정', Cmp: ShieldCheck },
  { name: 'shield-alert', label: '위험', group: '품질·판정', Cmp: ShieldAlert },
  { name: 'list-checks', label: '점검목록', group: '품질·판정', Cmp: ListChecks, keywords: '체크리스트' },
  { name: 'clipboard-check', label: '승인', group: '품질·판정', Cmp: ClipboardCheck },
  { name: 'file-check', label: '검토완료', group: '품질·판정', Cmp: FileCheck },
  { name: 'info', label: '정보', group: '품질·판정', Cmp: Info },
  { name: 'eye', label: '관찰', group: '품질·판정', Cmp: Eye, keywords: '모니터링' },

  // ── 지표 · 성과 ──────────────────────────────────────────────────
  { name: 'chart-column', label: '막대그래프', group: '지표·성과', Cmp: ChartColumn, keywords: '통계' },
  { name: 'chart-line', label: '추세', group: '지표·성과', Cmp: ChartLine, keywords: '선그래프' },
  { name: 'chart-pie', label: '비율', group: '지표·성과', Cmp: ChartPie, keywords: '원그래프' },
  { name: 'trending-up', label: '상승', group: '지표·성과', Cmp: TrendingUp, keywords: '증가 개선' },
  { name: 'trending-down', label: '하락', group: '지표·성과', Cmp: TrendingDown, keywords: '감소' },
  { name: 'activity', label: '변동', group: '지표·성과', Cmp: Activity },
  { name: 'target', label: '목표', group: '지표·성과', Cmp: Target },
  { name: 'flag', label: '이정표', group: '지표·성과', Cmp: Flag, keywords: '마일스톤' },
  { name: 'award', label: '성과', group: '지표·성과', Cmp: Award, keywords: '수상' },
  { name: 'coins', label: '비용', group: '지표·성과', Cmp: Coins, keywords: '원가 돈' },

  // ── 생산 · 공급 ──────────────────────────────────────────────────
  { name: 'factory', label: '생산', group: '생산·공급', Cmp: Factory, keywords: '공장 양산' },
  { name: 'warehouse', label: '창고', group: '생산·공급', Cmp: Warehouse, keywords: '재고' },
  { name: 'container', label: '물류', group: '생산·공급', Cmp: Container },
  { name: 'truck', label: '납품', group: '생산·공급', Cmp: Truck, keywords: '배송 운송' },
  { name: 'package', label: '포장', group: '생산·공급', Cmp: Package, keywords: '패키지' },
  { name: 'boxes', label: '자재', group: '생산·공급', Cmp: Boxes },
  { name: 'handshake', label: '협력사', group: '생산·공급', Cmp: Handshake, keywords: '공급사 계약' },
  { name: 'wrench', label: '정비', group: '생산·공급', Cmp: Wrench, keywords: '수리 조치' },
  { name: 'hammer', label: '개조', group: '생산·공급', Cmp: Hammer },
  { name: 'cog', label: '공정', group: '생산·공급', Cmp: Cog, keywords: '설비 기어' },
  { name: 'settings', label: '설정', group: '생산·공급', Cmp: Settings, keywords: '조건' },
  { name: 'recycle', label: '재활용', group: '생산·공급', Cmp: Recycle, keywords: '친환경' },
  { name: 'leaf', label: '환경', group: '생산·공급', Cmp: Leaf },

  // ── 데이터 · 소프트웨어 ──────────────────────────────────────────
  { name: 'database', label: '데이터', group: '데이터·SW', Cmp: Database },
  { name: 'server', label: '서버', group: '데이터·SW', Cmp: Server },
  { name: 'hard-drive', label: '저장장치', group: '데이터·SW', Cmp: HardDrive },
  { name: 'cloud', label: '클라우드', group: '데이터·SW', Cmp: Cloud },
  { name: 'code', label: '코드', group: '데이터·SW', Cmp: Code, keywords: '펌웨어 소프트웨어' },
  { name: 'terminal', label: '실행', group: '데이터·SW', Cmp: Terminal, keywords: '명령' },
  { name: 'layers', label: '계층', group: '데이터·SW', Cmp: Layers, keywords: '구조 스택' },
  { name: 'filter', label: '필터', group: '데이터·SW', Cmp: Filter, keywords: '선별' },
  { name: 'search', label: '조사', group: '데이터·SW', Cmp: Search, keywords: '검색 탐색' },
  { name: 'link', label: '연결', group: '데이터·SW', Cmp: Link },
  { name: 'lock', label: '보안', group: '데이터·SW', Cmp: Lock, keywords: '잠금' },

  // ── 일정 · 조직 ──────────────────────────────────────────────────
  { name: 'workflow', label: '흐름', group: '일정·조직', Cmp: Workflow, keywords: '프로세스' },
  { name: 'git-branch', label: '분기', group: '일정·조직', Cmp: GitBranch, keywords: '버전' },
  { name: 'milestone', label: '단계', group: '일정·조직', Cmp: Milestone, keywords: '게이트' },
  { name: 'clock', label: '시간', group: '일정·조직', Cmp: Clock },
  { name: 'calendar', label: '일정', group: '일정·조직', Cmp: Calendar },
  { name: 'calendar-clock', label: '기한', group: '일정·조직', Cmp: CalendarClock, keywords: '마감' },
  { name: 'history', label: '이력', group: '일정·조직', Cmp: History, keywords: '과거' },
  { name: 'refresh', label: '갱신', group: '일정·조직', Cmp: RefreshCw, keywords: '반복 재시험' },
  { name: 'users', label: '조직', group: '일정·조직', Cmp: Users, keywords: '팀 사람' },
  { name: 'user', label: '담당자', group: '일정·조직', Cmp: User },
  { name: 'building', label: '부서', group: '일정·조직', Cmp: Building2, keywords: '사업장' },

  // ── 문서 · 기타 ──────────────────────────────────────────────────
  { name: 'file-text', label: '문서', group: '문서·기타', Cmp: FileText, keywords: '보고서' },
  { name: 'clipboard-list', label: '목록', group: '문서·기타', Cmp: ClipboardList },
  { name: 'book', label: '규격', group: '문서·기타', Cmp: Book, keywords: '표준 매뉴얼' },
  { name: 'lightbulb', label: '아이디어', group: '문서·기타', Cmp: Lightbulb, keywords: '제안 개선' },
  { name: 'sparkles', label: '신규', group: '문서·기타', Cmp: Sparkles, keywords: 'ai 특징' },
]

/** 저장 이름 → 컴포넌트. */
export const CARD_ICONS = Object.fromEntries(
  CARD_ICON_DEFS.map((d) => [d.name, d.Cmp]),
)

export const CARD_ICON_NAMES = CARD_ICON_DEFS.map((d) => d.name)

/** 이름 → 컴포넌트. 허용셋 밖이면 null(렌더 생략 — 깨진 아이콘 대신 무시). */
export function cardIconComponent(name) {
  return (typeof name === 'string' && CARD_ICONS[name]) || null
}

/** 이름 → 한글 라벨(피커·툴팁용). 없으면 이름 그대로. */
export function cardIconLabel(name) {
  return CARD_ICON_DEFS.find((d) => d.name === name)?.label ?? name ?? ''
}

/**
 * 검색 — 한글 라벨 · 저장 이름 · 보조 키워드 · 그룹명을 모두 훑는다.
 * 빈 질의면 전체. 한글로 찾는 게 기본이라 라벨을 먼저 본다.
 */
export function searchCardIcons(query) {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return CARD_ICON_DEFS
  return CARD_ICON_DEFS.filter((d) =>
    d.label.toLowerCase().includes(q) ||
    d.name.includes(q) ||
    (d.keywords ?? '').includes(q) ||
    d.group.toLowerCase().includes(q),
  )
}
