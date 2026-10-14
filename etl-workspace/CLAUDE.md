@AGENTS.md

## Claude 전용

- 슬래시 명령:
  - `/briefing`: 오늘의 학업 브리핑
  - `/deadlines [일수]`: 다가오는 마감 정리 (기본 14일)
  - `/todo <내용>`: 할 일 추가
- `node etl.js …` 실행과 `todos.md` 편집은 이 폴더의 `.claude/settings.json`에서 미리 허용되어 있습니다. 그 밖의 명령은 사용자 승인을 받습니다.
- Bash 도구와 PowerShell 도구 중 무엇을 써도 됩니다. 명령은 그대로 `node etl.js …`로 실행합니다.
