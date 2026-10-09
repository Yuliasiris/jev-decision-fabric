---
name: decision-fabric
description: Use the existing Jev plugin for bounded decisions on supplied observations; select only tools actually advertised by the connected server.
---

# Decision Fabricの使い方

ユーザーの意図と、必要な資料・問いの選択は呼び出し元が担う。モデルの
結果は助言であり、作者の採否、権限、実行完了を上書きしない。

## まずツール一覧を確認する

`decision_evaluate`があれば従来どおり使える。`decision_run_v1`はserverの
二つのflagが有効な候補でのみ追加される。この文書を読めたことを、
serverが配備済み・ツールが利用可能という証拠にしない。新toolがない
場合、stateへ計画やprovider名を埋め込んで代用しない。

現在の公開質問セットは次の四つ。質問の意味を別用途へ読み替えない。

- `ops-liveness-v0`: 提供されたrun・返却・停止等の観測。
- `roi-delta-v0`: 変更された競馬FACTと再検討の範囲。勝率や馬券生成ではない。
- `music-routing-v0`: 音楽の解析後の操作経路。WAV採譜や歌詞認識ではない。
- `synthetic-smoke-v0`: 接続確認。実タスクの代わりに繰り返さない。

## 一回で済むことは一回で済ませる

hash比較、既知ID、数値の厳密計算、明示された権限は、既存の確定処理を使う。
モデルへ送る状態は必要な観測だけにする。私的なURLを付けてもserverが
それを読めるわけではない。原音・秘密情報を勝手に外送しない。

有限計画が必要で、新toolが実際にある場合のみ、version=1、topology、
stepsを渡す。stepにはid、question_set、stateを書く。provider、URL、
認証、scope、新しい質問本文は指定できない。最大8step、18秒であり、
各stepのJev呼出しは利用量を消費する。複数stepの同じJevを、独立した
複数モデルと呼ばない。

`single`は一つ。`compose`の`reads`は、以前のどの結果を使うかを明示する。
`after`だけでは本文を渡さない。`cross-check`は同じ入力と質問を比較し、
他者の結果を先に見せない。実行できないstepを避けるために前提を作らない。

## 返答を受け取る

`return_values`は値を返す指定。Noul=0.5やChoice=unknownも有効な回答で、
`answered`は「正しい」「承認された」の意味ではない。
`hold_on_unknown`はliteral unknownで保留、`need_evidence_on_unknown`は
資料不足へ戻す。数値を独自の勝率・正答率へ直さない。

`need_evidence`なら必要な資料を確認・取得し、目的に必要な場合だけ新しい
有限依頼を作る。`reframe`なら問い・候補が適切か見直す。`hold`なら保留を
残す。複数質問が異なるfollow-upを要求した場合は`by_question`と`next_actions`
を読み、単一の優先順位へ潰さない。`next_action`がnullでも「何もない」とは限らない。
不一致を多数決や無条件の確率平均で消さない。非対応、未認可、429、
timeoutを「判断不能という回答」に書き換えない。自動で有料再試行しない。

通常の旧toolは本線だけを実行する。shadow比較は行っていない。明示同期
比較は相手の返答を待つ。非同期で後から比較が完了すると約束しない。

trace IDは今回の実行記録への対応。`x-jev-trace-readback=verified`は、serverが
private Storeの最終trace記録を内部で読戻せたことだけを示す。元の全文や再開状態が
保存されたことは意味しない。現在trace内容を読む公開toolはない。返答の範囲を超えて
既読や本番使用を主張しない。
