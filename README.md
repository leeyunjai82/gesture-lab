# 제스처 랩 (Gesture Lab)

웹캠으로 잡은 **몸의 좌표(손·얼굴·포즈)** 를 학생이 직접 모아 AI를 학습시키고,
그 모델이 화면에서 즉시 동작하는 것을 확인하는 **수업용 정적 웹앱**입니다.

- 백엔드 없음 — 전부 정적 파일
- 외부 CDN 없음 — 라이브러리·모델 전부 셀프호스팅 (최초 로드 후 오프라인 동작)
- 영상·좌표는 브라우저 밖으로 나가지 않습니다

## 화면

| 페이지 | 역할 |
|---|---|
| [학습실](./index.html) | 소스 선택(손/얼굴/포즈) → 종류 만들기 → 예시 모으기 → 배우기 → 결과(맞힌 비율·헷갈린 표) → 저장 |
| [시험실](./test.html) | 단일 모드(확률 막대·확신도 임계값), 조합 모드(소스별 모델 최대 3개 + 규칙표 AND/OR) |
| [보관함](./storage.html) | 저장 모델 목록 / 이름 변경 / 삭제 / zip 내보내기·불러오기 |

## 실행

`file://` 로는 열 수 없습니다. 반드시 http 로 서빙하세요.

```bash
npx http-server -p 8080          # 또는
python3 -m http.server 8080
```

### MIME 주의

서버가 아래 타입을 내보내야 합니다. 틀리면 wasm 스트리밍 컴파일이 실패합니다.

| 확장자 | MIME |
|---|---|
| `.wasm` | `application/wasm` |
| `.task` | `application/octet-stream` |
| `.mjs` | `text/javascript` |

Go 서버(`pibo-server` 계열) 사용 시 `mime.AddExtensionType` 로 명시 등록하세요.

## 구조

```
index.html / test.html / storage.html
css/
  ui.css             공통 UI 규격 (파이보 랩과 동일)
  app.css            이 서비스 전용
lib/
  nav.js             헤더/탭 네비게이션
  landmarker.js      MediaPipe 로드/전환/추론 (GPU 실패 시 CPU 폴백)
  features.js        특징 벡터 전처리 (손 63 / 얼굴 blendshape 52 / 포즈 상반신 75)
  trainer.js         TF.js 분류기 학습 (Dense32-Dropout-Softmax)
  store.js           IndexedDB 저장 + zip 내보내기/불러오기
  i18n.js            한/영 토글 (파이보 랩과 같은 방식)
  learn.js / exam.js / storage_page.js   페이지 로직
vendor/
  tasks-vision/      @mediapipe/tasks-vision wasm + vision_bundle.mjs
  tfjs/              @tensorflow/tfjs tf.min.js
models/              hand / face / pose_lite .task
                     + efficientdet_lite0(사물 감지) / selfie_segmenter(배경 분리) .tflite
assets/fonts/        Pretendard (셀프호스팅)
assets/img/          캐릭터·로고
```

## 벤더 파일 갱신

```bash
npm i @mediapipe/tasks-vision @tensorflow/tfjs
cp node_modules/@mediapipe/tasks-vision/wasm/*        vendor/tasks-vision/
cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs vendor/tasks-vision/
cp node_modules/@tensorflow/tfjs/dist/tf.min.js       vendor/tfjs/
```

`.task` 모델은 MediaPipe 공식 모델 저장소에서 받아 `models/` 에 둡니다
(`hand_landmarker`, `face_landmarker`, `pose_landmarker_lite` — 포즈는 lite 고정).
`node_modules` 는 커밋하지 않고, 벤더 파일은 커밋합니다.

## 배포 (파이보 랩과 동일)

- `main` 에 작업 → GitHub Pages 테스트 → 통과하면 `release` 브랜치 머지 → Cloudflare 자동 배포
- Cloudflare 는 Workers 방식: `wrangler.toml` + `.assetsignore` + `src/index.js`
- 배포 명령: `npx wrangler deploy`
- 시험 기간 잠금: `npx wrangler secret put BASIC_USER` / `BASIC_PASS` (둘 다 설정될 때만 켜짐)
- 캐시 버스팅: 코드 파일만 `?v=N`. 모델·wasm 파일에는 붙이지 않습니다
- 모든 자산 경로는 상대경로 — 하위 경로(`/gesture-lab/`) 서빙에서도 동작합니다
