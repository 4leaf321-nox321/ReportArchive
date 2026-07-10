"""모든 ORM 모델을 한 번에 import 하는 집계 모듈.

워커(worker.py)처럼 FastAPI 앱 전체를 띄우지 않는 프로세스에서, 핸들러가
임의의 도메인 모델(Report·File·Composite…)을 건드릴 때 SQLAlchemy 매퍼가
깨끗하게 configure 되도록 *모든* 모델을 Base.metadata 에 등록한다. 한
모델의 relationship 대상이 빠지면 첫 쿼리에서 매퍼 configure 가 실패하므로,
일부만이 아니라 models.py 가 있는 모든 모듈을 빠짐없이 import 한다.

migrations/env.py 도 비슷한 import 목록을 갖지만 그 파일은 import 시 alembic
컨텍스트를 실행하므로 일반 코드에서 재사용할 수 없어 별도로 둔다.
새 모듈 모델을 추가하면 여기에 한 줄 추가.
"""
from __future__ import annotations

# noqa: F401 — 전부 등록 부작용용 import (models.py 보유 모듈 전체)
from app.modules.access_logs import models as _access_logs  # noqa: F401
from app.modules.app_settings import models as _app_settings  # noqa: F401
from app.modules.eval import models as _eval  # noqa: F401
from app.modules.activities import models as _activities  # noqa: F401
from app.modules.comments import models as _comments  # noqa: F401
from app.modules.composite_presets import models as _composite_presets  # noqa: F401
from app.modules.composites import models as _composites  # noqa: F401
from app.modules.connectors import models as _connectors  # noqa: F401
from app.modules.editors import models as _editors  # noqa: F401
from app.modules.embed import models as _embed  # noqa: F401
from app.modules.entities import models as _entities  # noqa: F401
from app.modules.files import models as _files  # noqa: F401
from app.modules.folders import models as _folders  # noqa: F401
from app.modules.grants import models as _grants  # noqa: F401
from app.modules.mounts import models as _mounts  # noqa: F401
from app.modules.notifications import models as _notifications  # noqa: F401
from app.modules.pins import models as _pins  # noqa: F401
from app.modules.presets import models as _presets  # noqa: F401
from app.modules.prompts import models as _prompts  # noqa: F401
from app.modules.report_types import models as _report_types  # noqa: F401
from app.modules.reports import models as _reports  # noqa: F401
from app.modules.section_taxonomy import models as _section_taxonomy  # noqa: F401
from app.modules.template_categories import models as _template_categories  # noqa: F401
from app.modules.template_metrics import models as _template_metrics  # noqa: F401
from app.modules.templates import models as _templates  # noqa: F401
from app.modules.users import models as _users  # noqa: F401
from app.modules.voc import models as _voc  # noqa: F401
from app.modules.widget_relations import models as _widget_relations  # noqa: F401
from app.modules.workspaces import models as _workspaces  # noqa: F401
from app.jobs import models as _jobs  # noqa: F401
from app.ai import models as _ai  # noqa: F401  (RAG: report_chunks)
