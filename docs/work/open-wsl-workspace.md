---
title: 「ほかのワークスペース」の行を押すと、WSL でもそのセッションへ移れるようにする
status: done
---

## 目的
出典: 端末からの入力（会話 bb35cd82、2026-11-22 18:58、発言 e166720f）
要旨（Claude の要約）: パネルの「ほかのワークスペース」の行を押したら、そのワークスペースのセッションへ移れるようにする。Mac で動く fork 元ではできているはずで、こちらは Windows の Orca と WSL の組み合わせで使っている。

## いまの方針
ホストの `workspace.list` にそのパスのワークスペースが無いときは、ワーカーが既に使っている Orca CLI（WSL の環境を名指しする）で `terminal list` を引き、そのパスのターミナル（エージェントのものを優先し、最後に出力したもの）へ `terminal switch` する。ホストの一覧に見つかるとき（Mac）は今までどおり `workspace.open` を使う。

## 判明した事実
- Windows の Orca では、プラグインのワーカーは Windows 側のランタイムで動き、ホストの `workspace.list` は WSL のワークスペースを 1 件も返さない（一時のログで `n=0` を確かめた）。行を押すと「no workspace to open at <path>」のログだけが残り、何も開かない。
- ホストの `workspace.open` に WSL の worktreeId を渡しても「no workspace has this id」で通らない。Orca 本体の実装では、渡された id をワーカーのランタイムの `worktree.activate` に回すだけだった。
- `orca.exe worktree activate --environment "<distro> (WSL)"` は `activated: true` を返すが、デスクトップのフォーカスは動かなかった（画面で確かめた）。
- `orca.exe terminal switch --terminal <WSL のターミナル> --environment "<distro> (WSL)"` は `navigated: true` を返し、デスクトップがそのワークスペースのセッションへ移った。元のタブへ戻すのも同じ方法でできた。リーダーが試しの最中に画面に触ったかもしれないと言ったため、同じ手順を一度やり直し、2 回とも画面で確かめた（2026-11-22）。
- `orca terminal list --json` の各ターミナルは `worktreePath` と `agentIdentity`、`lastOutputAt` を持つ。

## 判断の経緯
### 2026-11-22 採用: WSL のワークスペースは、環境を名指しした CLI の `terminal switch` で前面に出す
- 出どころ: Claude の判断
- 理由: ホストの API は WSL のワークスペースに届かず、CLI の `worktree activate` はデスクトップを動かさない。`terminal switch` だけが画面を動かした。エージェントのターミナルへ移れば、依頼の「そのセッションへ移る」にそのまま当たる。
- 状態: 有効

### 2026-11-22 棄却: CLI の `worktree activate` で開く
- 理由: 実機で、デスクトップのフォーカスが動かなかった。
- 状態: 有効

#### いまの作業
なし（済み）。

## 済んだこと
- 原因の実測（上の事実）。
- `openWorkspace` の修正と、そのテスト（0db12d7）。全 116 件が通る。
- コードレビュー（指摘なしで「マージしてよい」。前提を崩す指摘なし）。気にされた点は、パネルの行の path と `terminal list` の `worktreePath` が同じ形か。調べた時点で、どちらも `/home/<user>/repo/...` の同じ形だった。
- リーダーの承認を受け、ローカルの `wsl-host` を修正まで進めて実機の Orca に読み込み直した。パネルの「ほかのワークスペース」の行を Computer Use で押すと、そのワークスペースの Claude のセッションへ移り、パネルの先頭もそのワークスペースになることを画面で確かめた（2026-11-22）。

## 残っていること
- fork の `wsl-host` への push（今までの作業と同じく、リーダーの承認を取ってから）。

## 次に Claude がすること
- リーダーが指示したら、差分と履歴に非公開の名前が無いかを確かめてから、fork の `wsl-host` に push する。

## リーダーに決めてほしいこと
なし

 参照
- 修正: 0db12d7（`src/milestone-worker.mjs` の `openWorkspace`）
