# Play Store Games on Sale Alert

Google Play의 "Games on sale" 컬션을 매일 스크랩해 **새로 할인에 들어간 유료 게임**만 이메일로 알려주는 자동화 시스템.

## 왜 이 구조인가

| 제약 | 결론 |
|---|---|
| Google Apps Script는 Playwright를 실행할 수 없음 | 브라우저 렌더링·무한스크롤은 GitHub Actions에서 수행 |
| Play Store 컬렉션은 SSR + XHR 페이징 구조 | 초기 HTML만 긁으면 **20개**가 한계 (실측) |
| `hl=en`만 쓰면 할인 정보가 거의 없음 | **`&gl=US` 필수** (실측: 할인배지 2개 → 17개) |
| 무한스크롤이 필요 | Playwright 스크롤로 **20개 → 173개** (실측) |
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
   └─ node send_to_gas.js               (POST {token, games[]})
        │
        ▼
[GAS Web App doPost]
   ├─ 토큰 검증
   ├─ packageId 기준 중복 제거 (PropertiesService)
   ─ GmailApp.sendEmail → lostempus06@gmail.com
```

## 실측 성능 (2026-09)

| 지표 | 값 |
|---|---|
| 초기 카드 | 20 |
| 무한스크롤 후 | **173** (고유 packageId 173) |
| 할인 유료게임 | **115** |
| 스크롤 수 / 소요 | 7~9회 / 12~15초 |
| 할인 정보 파싱 성공률 | 115/115 (100%) |

## 폴더 구조

```
002_GoogleAppScript/
├─ .github/workflows/play-store-sales.yml   # cron + 수동 실행
├─ .gitignore
├─ README.md
└─ 01_PlayStoreSales/
    ├─ Code.gs              # GAS v3.0 (doPost/doGet/트리거/이메일)
    ├─ appsscript.json      # webapp 설정 + oauthScopes
    └─ scraper/
        ├─ package.json
        ├─ selectors.js     # DOM 셀렉터 + 폴백 체인
        ├─ scrape.js        # Playwright 무한스크롤 스크래퍼
        ├─ send_to_gas.js   # GAS Web App POST (재시도 3회)
        └─ probe.py         # 최초 계측용 (Python, 참고용 보존)
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

# GAS 전송 없이 확인
node send_to_gas.js --dry-run
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
- `?hl=en&gl=US` 파라미터를 변경하면 할인 정보가 누락될 수 있습니다 (실측 근거).
- 통화는 USD 기준으로 파싱됩니다. 다른 통화가 필요하면 `selectors.js`는 그대로 두고 `scrape.js`의 `PRICE_PATTERN`과 `TARGET_URL`의 `gl` 값을 조정하세요.