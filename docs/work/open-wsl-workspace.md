---
title: 「ほかのワークスペース」の行を押すと、WSL でもそのセッションへ移れるようにする
status: active
---

## 目的
出典: 端末からの入力（会話 bb35cd82、2026-11-22 18:58、発言 e166720f）
要旨（Claude の要約）: パネルの「ほかのワークスペース」の行を押したら、そのワークスペースのセッションへ移れるようにする。Mac で動く fork 元ではできているはずで、こちらは Windows の Orca と WSL の組み合わせで使っている。

## いまの方針
押してから切り替わるまでの遅れも縮める（出典: 端末からの入力（会話 bb35cd82、2026-11-22 19:14、発言 5387914d）。要旨（Claude の要約）: クリックしてから遷移までが遅い）。
ホストの `workspace.list` にそのパスのワークスペースが無いときは、ワーカーが既に使っている Orca CLI（WSL の環境を名指しする）で `terminal list` を引き、そのパスのターミナル（エージェントのものを優先し、最後に出力したもの）へ `terminal switch` する。ターミナルの一覧は更新のあとに裏で引いておき、押したときは `terminal switch` だけを打つ。ホストの一覧に見つかるとき（Mac）は今までどおり `workspace.open` を使う。

## 判明した事実
- Windows の Orca では、プラグインのワーカーは Windows 側のランタイムで動き、ホストの `workspace.list` は WSL のワークスペースを 1 件も返さない（一時のログで `n=0` を確かめた）。行を押すと「no workspace to open at <path>」のログだけが残り、何も開かない。
- ホストの `workspace.open` に WSL の worktreeId を渡しても「no workspace has this id」で通らない。Orca 本体の実装では、渡された id をワーカーのランタイムの `worktree.activate` に回すだけだった。
- `orca.exe worktree activate --environment "<distro> (WSL)"` は `activated: true` を返すが、デスクトップのフォーカスは動かなかった（画面で確かめた）。
- `orca.exe terminal switch --terminal <WSL のターミナル> --environment "<distro> (WSL)"` は `navigated: true` を返し、デスクトップがそのワークスペースのセッションへ移った。元のタブへ戻すのも同じ方法でできた。リーダーが試しの最中に画面に触ったかもしれないと言ったため、同じ手順を一度やり直し、2 回とも画面で確かめた（2026-11-22）。
- `orca terminal list --json` の各ターミナルは `worktreePath` と `agentIdentity`、`lastOutputAt` を持つ。
- 行を押してから切り替わるまで約 1.15 秒かかっていた。実際のワーカーの中で測った区間は、ホストの `workspace.list` が 0〜1ms、CLI の `terminal list` が約 0.45 秒、CLI の `terminal switch` が約 0.7 秒（3 回とも同じ傾向、2026-11-22）。
- ホストの `terminal.focus` に WSL のターミナルの handle を渡すと `terminal_handle_stale` で通らない。CLI の `terminal switch` は handle しか受けない。だから押したあとの CLI の `terminal switch` 1 回（約 0.7 秒）は避けられない。

## 判断の経緯
### 2026-11-22 採用: WSL のワークスペースは、環境を名指しした CLI の `terminal switch` で前面に出す
- 出どころ: Claude の判断
- 理由: ホストの API は WSL のワークスペースに届かず、CLI の `worktree activate` はデスクトップを動かさない。`terminal switch` だけが画面を動かした。エージェントのターミナルへ移れば、依頼の「そのセッションへ移る」にそのまま当たる。
- 状態: 有効

### 2026-11-22 棄却: CLI の `worktree activate` で開く
- 理由: 実機で、デスクトップのフォーカスが動かなかった。
- 状態: 有効

### 2026-11-22 採用: ターミナルの一覧は更新のあとに裏で引いておき、押したときは `terminal switch` だけを打つ
- 出どころ: Claude の判断（遅れの指摘は 端末からの入力（会話 bb35cd82、2026-11-22 19:14、発言 5387914d））
- 理由: 押してからの遅れのうち、`terminal list` の約 0.45 秒は押す前に済ませられる。裏の取得は await しないので、カードが出るまでの時間には乗らない。覚えた handle が古くて切り替えに失敗したときだけ引き直す。Mac ではホストで開けるので、この先取りは WSL のときだけ有効にする。
- 状態: 有効

## いまの作業
押したときの遅れを縮める修正（4971c4f、テスト 118 件が通る）のコードレビューを受けている。

## 済んだこと
- 原因の実測（上の事実）。
- `openWorkspace` の修正と、そのテスト（0db12d7）。
- コードレビュー（指摘なしで「マージしてよい」。前提を崩す指摘なし）。気にされた点は、パネルの行の path と `terminal list` の `worktreePath` が同じ形か。調べた時点で、どちらも `/home/<user>/repo/...` の同じ形だった。
- リーダーの承認を受け、ローカルの `wsl-host` を修正まで進めて実機の Orca に読み込み直した。パネルの「ほかのワークスペース」の行を Computer Use で押すと、そのワークスペースの Claude のセッションへ移り、パネルの先頭もそのワークスペースになることを画面で確かめた（2026-11-22）。
- 押したときの遅れの区間を実際のワーカーで測り、ターミナルの一覧を先に引いておく修正を入れた（4971c4f）。

## 残っていること
- 遅れを縮める修正のコードレビューを受けて直す。
- ローカルの `wsl-host` を進めて実機に読み込み直し、押してから切り替わるまでの時間を測り直す。
- fork の `wsl-host` への push（今までの作業と同じく、リーダーの承認を取ってから）。

## 次に Claude がすること
- レビューの指摘を receiving-code-review で受けて直し、`wsl-host` を進めて読み込み直し、押してからの時間をワーカーのログで測る。

## リーダーに決めてほしいこと
なし

## 参照
- 修正: 0db12d7（`src/milestone-worker.mjs` の `openWorkspace`）
- 遅れを縮める修正: 4971c4f
