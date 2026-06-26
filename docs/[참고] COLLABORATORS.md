# 협업자 초대 가이드

이 레포는 **Private** 이므로 코드를 보거나 받으려면 owner 가 collaborator 로 초대해야 합니다.

---

## 1단계: Owner 가 GitHub 웹에서 상대를 초대

1. https://github.com/4leaf321-nox321/ReportArchive 접속
2. 상단 **Settings** 탭 클릭
3. 왼쪽 사이드바에서 **Collaborators** 클릭
4. **Add people** 버튼 → 상대방 **GitHub 계정명** 또는 **GitHub 가입 이메일** 입력 → Add
5. 상대방 이메일로 초대 메일이 발송됨 (또는 GitHub 알림)

> 상대방이 GitHub 계정이 없으면 먼저 https://github.com/signup 에서 가입 필요. 가입 시 사용한 유저명/이메일을 owner 에게 알려주면 그걸로 초대.

---

## 2단계: 초대받은 사람이 수락 + clone

### 2-1. 초대 수락

- 초대 메일의 **View invitation** 링크 클릭 → **Accept invitation**
- 또는 https://github.com/4leaf321-nox321/ReportArchive 직접 접속해서 Accept

### 2-2. Git 설치

- https://git-scm.com/downloads 에서 다운로드 → 설치
- 설치 중 **Git Credential Manager** 옵션은 켠 채로 진행 (기본값)

### 2-3. clone

원하는 상위 폴더에서 PowerShell 또는 Git Bash 실행:

```powershell
cd C:\원하는\상위폴더
git clone https://github.com/4leaf321-nox321/ReportArchive.git
```

- 최초 실행 시 **브라우저 창이 자동으로 열리면서 GitHub 로그인 요구**
- 본인 GitHub 계정으로 로그인 + Authorize
- 인증되면 clone 진행되고 `ReportArchive` 폴더 생성됨

### 2-4. 이후 업데이트 받기

clone 받은 폴더 안에서:

```powershell
cd ReportArchive
git pull
```

- 재인증 불필요 (GCM 이 자격 증명 캐시)

---

## CLI 가 부담스러운 경우 — GitHub Desktop

GUI 도구: https://desktop.github.com

- 설치 후 GitHub 계정으로 로그인
- File → Clone repository → 레포 목록에서 `ReportArchive` 선택 → Clone
- 이후 pull / push 도 버튼 클릭으로 가능
