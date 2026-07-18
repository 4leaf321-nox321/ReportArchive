// 카드 위젯 아이콘 허용셋 — 저장되는 이름(kebab-case) → lucide 컴포넌트.
//
// ⚠️ 이 목록은 backend `app/widgets/registry.py` 의 `_CARD_ICONS` 와 **쌍**이다.
// 백엔드는 enum 으로 저장을 거부하고, 여기는 실제로 그릴 수 있는 것을 정한다.
// 한쪽에만 추가하면: 백엔드만 → 저장은 되는데 화면에 안 그려짐(조용히 무시),
// 프론트만 → 저장이 422 로 거부됨. **반드시 함께** 고칠 것.
//
// 임의의 lucide 이름을 허용하지 않는 이유: (1) 정적 import 해야 번들에 들어가고,
// (2) PPTX/DOCX export 가 같은 셋만 래스터화할 수 있기 때문(export 경로가 이
// 맵을 그대로 재사용한다).
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Beaker,
  Building2,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Clock,
  Cpu,
  Database,
  Factory,
  FileText,
  Flag,
  Gauge,
  Info,
  Layers,
  Lightbulb,
  Microscope,
  Network,
  Package,
  Search,
  Settings,
  Share2,
  Shield,
  Target,
  TrendingDown,
  TrendingUp,
  Truck,
  Users,
  Wrench,
  Zap,
} from 'lucide-react'

/** 저장 이름 → 컴포넌트. 피커의 노출 순서이기도 하다(그룹 단위로 묶어 둠). */
export const CARD_ICONS = {
  // 개념·구조
  network: Network,
  share: Share2,
  layers: Layers,
  package: Package,
  database: Database,
  cpu: Cpu,
  settings: Settings,
  // 방향·성과
  target: Target,
  flag: Flag,
  'trending-up': TrendingUp,
  'trending-down': TrendingDown,
  activity: Activity,
  gauge: Gauge,
  // 상태·판정
  'check-circle': CheckCircle2,
  'alert-triangle': AlertTriangle,
  'alert-circle': AlertCircle,
  info: Info,
  shield: Shield,
  // 일정·사람
  clock: Clock,
  calendar: Calendar,
  users: Users,
  building: Building2,
  // 업무·문서
  'file-text': FileText,
  'clipboard-list': ClipboardList,
  search: Search,
  wrench: Wrench,
  beaker: Beaker,
  microscope: Microscope,
  truck: Truck,
  factory: Factory,
  lightbulb: Lightbulb,
  zap: Zap,
}

export const CARD_ICON_NAMES = Object.keys(CARD_ICONS)

/** 이름 → 컴포넌트. 허용셋 밖이면 null(렌더 생략 — 깨진 아이콘 대신 무시). */
export function cardIconComponent(name) {
  return (typeof name === 'string' && CARD_ICONS[name]) || null
}
