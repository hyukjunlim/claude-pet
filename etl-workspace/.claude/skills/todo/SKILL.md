---
name: todo
description: todos.md에 개인 할 일을 추가한다.
argument-hint: "<할 일 내용, 마감, 과목>"
disable-model-invocation: true
allowed-tools: Read(./todos.md) Edit(./todos.md) Bash(node etl.js check) PowerShell(node etl.js check)
---

다음 내용을 `todos.md`의 "진행 중" 섹션에 추가한다: $ARGUMENTS

- 형식은 `- [ ] 제목 | 마감: YYYY-MM-DD HH:MM | 과목: 과목명 | 메모`를 따른다.
  - 없는 항목은 생략한다.
- "내일", "금요일" 같은 상대 날짜는 오늘(KST)을 기준으로 실제 날짜로 바꾼다.
  - 오늘 날짜를 모르면 `node etl.js check` 결과의 `now`를 참고한다. 펫이 꺼져 있어 확인할 수 없으면 사용자에게 날짜를 묻는다.
- 마감이 이른 순서를 유지하도록 적절한 위치에 넣는다.
- `todos.md` 외의 파일은 수정하지 않는다.
- 추가한 줄을 그대로 보여주며 확인한다.
