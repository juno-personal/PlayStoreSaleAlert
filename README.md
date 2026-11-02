# Play Store Games on Sale Alert

Google Play의 "Games on sale" 컬션을 매일 스크랩해 **새로 할인에 들어간 유료 게임**만 이메일로 알려주는 자동화 시스템.

## 왜 이 구조인가

| 제약 | 결론 |
|---|---|
| Google Apps Script는 Playwright를 실행할 수 없음 | 브라우저 렌더링·무한스크롤은 GitHub Actions에서 수행 |
| Play Store 컬렉션은 SSR + XHR 페이징 구조 | 초기 HTML만 긁으면 **20개**가 한계 (실측) |
| `hl`만 쓰고 `gl`을 빼면 할인 정보가 거의 없음 | **`&gl` 필수** (실측: 할인배지 2개 → 17개) |
| 무한스크롤이 필요 | Playwright 스크롤로 **20개 → 176개** (실측, ko/AE) |
| 카드 DOM에는 가격이 늦게 그려짐 | 초기 HTML + `batchexecute` 응답 파싱으로 **176/176 가격 확보** |
| Gmail 발송은 GAS가 가장 간단 | GAS가 수신·중복관리·발송 담당 |

## 아키텍처

```
[GAS 트리거 (매일 09:00 KST)]
        │  workflow_dispatch (Fine-grained PAT)
        ▼
[GitHub Actions: ubuntu-latest]
   ├─ npm ci
   ├─ playwright install chromium
   ├─ node scrape.js --out games.json   (무한스크롤 + 파싱)
   ├─ node build_site.mjs               (docs/index.html 생성)
   ├─ git commit/push docs/index.html   (GitHub Pages 자동 갱신)
   └─ node send_to_gas.js               (POST {token, games[]})
        │
        ▼
[GAS Web App doPost]
   ├─ 토큰 검증
   ├─ packageId 기준 중복 제거 (PropertiesService)
   └─ GmailApp.sendEmail → lostempus06@gmail.com
```

## 웹 페이지 (GitHub Pages)

무한스크롤로 모은 전체 목록을 **정적 페이지**로 발행합니다. Actions가 스크랩 직후 `docs/index.html`을 다시 만들고 커밋·푸시하므로 별도 서버가 필요 없습니다.

- 위치: `docs/index.html` (데이터 임베드, 외부 CDN·JS 의존성 없음)
- 사이트 URL: `https://lostempus06-eng.github.io/PlayStoreSaleAlert/`
- 정렬: **할인 종료 임박순**(기본, 오름차순), 화면에서 종료 늦은 순/할인율/이름순 전환 가능
- 기능: 이름 검색, 100% 할인(FREE)·할인율 배지, 종료 시각 표시, 반응형 3열 그리드

### 최초 1회 설정

1. 저장소 → **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / Folder: **`/docs`** → Save
4. 잠시 후 `https://<owner>.github.io/<repo>/` 접속

이후 매 실행마다 워크플로가 페이지를 갱신합니다 (`contents: write` 권한 사용).

## 실측 성능 (2026-11, `hl=ko&gl=AE`)

| 지표 | 값 |
|---|---|
| 초기 카드 | 20 |
| 무한스크롤 후 | **176** (고유 packageId 176) |
| 할인 유료게임 | **176** (가격 있는 유료 게임 전부) |
| 스크롤 수 / 소요 | 7회 / 15초 |
| 할인 정보 파싱 성공률 | 176/176 (100%, 통화 AED) |
| 할인 종료일 확보 | 176/176 (100%) |

## 폴더 구조

```
002_GoogleAppScript/
├─ .github/workflows/play-store-sales.yml   # 수동 실행 → 스크랩 → 페이지 갱신 → 메일
├─ .gitignore
├─ README.md
├─ docs/
│   └─ index.html         # GitHub Pages (자동 생성, 커밋됨)
└─ 01_PlayStoreSales/
    ├─ Code.gs              # GAS v3.0 (doPost/doGet/트리거/이메일)
    ├─ appsscript.json      # webapp 설정 + oauthScopes
    └─ scraper/
        ├─ package.json
        ├─ selectors.js     # DOM 셀렉터 + 로케일(hl/gl) 기본값
        ├─ scrape.js        # Playwright 무한스크롤 스크래퍼
        ├─ build_site.mjs   # games.json → docs/index.html
        ├─ send_to_gas.js   # GAS Web App POST (재시도 3회)
        └─ verify_gas_logic.mjs  # GAS 로직 로컬 검증 (PASS 21)
```

## 설정 절차

### 1. GAS 설정

1. [Apps Script](https://script.google.com)에서 새 프로젝트 생성
2. `Code.gs`, `appsscript.json` 내용 여넣기
3. **프로젝트 설정 → 스크립트 속성**에 아래 값 등록:

| 속성 | 값 |
|---|---|
| `SHARED_TOKEN` | 임의의 긴 랜덤 문자열 (예: `openssl rand -hex 32`) |
| `GITHUB_PAT` | Fine-grained PAT (`Actions: Read and write`) |
| `GITHUB_REPO` | `owner/repo` |
| `GITHUB_WORKFLOW` | `play-store-sales.yml` (기본값 사용 시 생략 가능) |
| `GITHUB_REF` | `main` (기본값 사용 시 생략 가능) |
| `SITE_URL` | `https://<owner>.github.io/<repo>/` (선택 · 이메일에 "전체 목록 보기" 버튼 추가) |

4. **배포 → 새 배포 → 웹 **
   - 실행 계정: **나 (USER_DEPLOYING)**
   - 세스 권한: **모든 사용자 (ANYONE_ANONYMOUS)**
   - 배포 후 `/exec` URL 복사
5. 함수 `setupDailyTrigger`를 1회 실행 (권한 승인)

### 2. GitHub 설정

```bash
# 저장소 생성 + push
gh auth login
gh repo create play-store-sales-scraper --private --source=. --remote=origin --push

# 시크릿 등록
gh secret set GAS_WEBAPP_URL   # GAS /exec URL
gh secret set GAS_TOKEN        # SHARED_TOKEN 과 동일한 값
```

### 3. 동작 확인

```bash
gh workflow run play-store-sales.yml
gh run list --workflow=play-store-sales.yml
gh run watch
```

## 로컬 테스트

```bash
cd 01_PlayStoreSales/scraper
npm ci

# 브라우저 다운로드 없이 시스템 Chrome 사용
node scrape.js --channel chrome --verbose --out games.json

# 웹 페이지 미리보기 생성 (../../docs/index.html)
node build_site.mjs --in games.json

# GAS 전송 없이 확인
node send_to_gas.js --dry-run

# GAS 이메일/중복 로직 검증 (+ 이메일 디자인 미리보기 저장)
node verify_gas_logic.mjs --dump-email
# → 01_PlayStoreSales/_debug/email_preview.html
```

## 유지보수 가이드

### 스크랩 결과가 0건일 때

`scrape.js`는 결과가 0건이면 **exit code 2로 실패**합니다 (사이트 구조 변경 조기 감지).
Play Store는 CSS 클래스명이 자주 바뀌므로 `selectors.js`의 렉터 체인을 갱신합니다.

```bash
# 현재 DOM 구조 확인
node scrape.js --channel chrome --headed --verbose
```

### 셀터 체인

`selectors.js`의 `FIELD_SELECTORS`는 배열이며, 앞에서부터 시도해 첫 매칭을 사용합니다.
클래스명이 바뀌면 **배열에 새 셀렉터를 추가**하기만 하면 됩니다 (기존 항목은 폴백으로 유지).

| 필드 | 1순위 셀렉터 |
|---|---|
| name | `span.sT93pb.DdYX5.OnEJge` |
| genre | `span.sT93pb.w2kbF` |
| discount | `span.W0agu` |
| originalPrice | `span.sT93pb.JUF8md.ePXqnb` |
| salePrice | `span.sT93pb.w2kbF.Q64Ric` |
| thumbnail | `img.T75of.stzEZd` |

### 이메일 구성

새로 할인에 들어간 게임만 **할인 종료 임박순(오름차순)**으로 한 통에 담아 보냅니다.

- 헤더: 신규 개수, 100% 할인 개수, 최대 할인율, (설정 시) 웹 목록 버튼
- 카드: 아이콘, 이름, 장르 · 별점, 정가(취소선) → 할인가, **절약 금액**, 할인 배지(FREE/-N%), **종료 시각**
- 푸터: 출처와 시간 기준(Dubai, ST+4)

### 중복 알림 제어

- 키: **`packageId`** 우선 (없으면 게임 이름)
- 값: 할인율 → **할인율이 바뀌면 다시 알림**
- 초기화: GAS에서 `clearSentGames()` 실행
- 개수 확인: `showSentGamesCount()`

### 토큰 만료

Fine-grained PAT는 만료일이 있습니다. 만료 시 `main()`이 실패하며 오류 이메일이 발송됩니다.
GitHub에서 새 토큰 발급 후 GAS 스크립트 속성 `GITHUB_PAT`만 갱신하면 됩니다.

## 비용

| 항목 | 사용량 |
|---|---|
| GitHub Actions | 1회 1~2분 × 30일 ≈ 45분/월 (무료 2,000분) |
| GAS 실행 | 워크플로 호출 1회/일 + doPost 1회/일 |
| Gmail | 1통/일 (한도 100통/일) |

## 주의사항

- 개인 알림 용도로만 사용하세요. 수집 데이터의 재배포는 Play Store 이용약관에 저촉될 수 있습니다.
- `hl=ko&gl=AE`(한국어 UI + AED 가격)가 기본값입니다. `gl`을 빼면 할인 정보가 누락됩니다 (실측 근거).
- 다른 언어/통화를 원하면 `node scrape.js --hl en --gl US` 처럼 실행하거나 `selectors.js`의 `DEFAULT_LOCALE`을 바꾸세요.