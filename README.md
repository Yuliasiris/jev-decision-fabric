# Jev Decision Fabric

TypeSafe Jevの有限な判断を、既存の作業へ組み込むMCP serverと実行部品です。配布先は [Yuliasiris/jev-decision-fabric](https://github.com/Yuliasiris/jev-decision-fabric) です。2026-10-09に、準備済みの43ファイルをmainで閲覧できるsourceとして公開しました。project-authored filesの再利用ライセンスは未確定で、MIT許諾は付与していません。公開はopen-sourceの再利用許諾、Directory掲載、production配備を意味しません。

現接続先はJev一種類です。固定質問へ観測を渡し、nativeのChoice・Noulを助言として扱います。汎用runnerの5方式は、別providerが稼働している証拠ではありません。

|質問セット|使う範囲|
|---|---|
|ops-liveness-v0|run・保存・返却・消費・局所阻害の観測|
|roi-delta-v0|変更された競馬FACTが既存分析へ及ぼす影響|
|music-routing-v0|解析観測と制作意図から、次に必要な処理を検討|
|synthetic-smoke-v0|一回の接続確認用fixture|

使い方の正本は [Decision Fabricの使い方](skills/decision-fabric/SKILL.md) です。入力例は [examples](examples/) 、型と実行契約は [FABRIC.md](FABRIC.md) と実装へ返しています。原音の採譜、歌詞認識、勝率算出、自動Apply、自由質問は提供していません。

2026-10-08時点の既存接続の道具一覧ではdecision_evaluateとdecision_run_v1が列挙されています。前者は固定質問への判断、後者は有限計画の実行に使います。利用中の接続でも実際の道具一覧を確認してください。stateへplanやprovider名を入れてnew toolの代わりにしません。各stepはTypeSafeへ送信され、利用量を消費します。二toolの列挙だけからPlugin version1.0.1や説明・Skillの配送完了は主張しません。

同時成立しうる候補、native値、校正された事象確率、効用を同一視しません。source/range/note ID、送信可能範囲、取消・revision、結果の戻し先は呼出元が解決します。serverは私的URLの原文を取得せず、未知は未知のまま残します。traceは実行記録であり、原資料や再開stateの完全保存ではありません。

## オフラインで動かす

Node 22以上が必要です。依存lockを使って導入します。

~~~sh
npm ci --ignore-scripts
node --experimental-strip-types examples/offline.mts
node --experimental-strip-types --test test/release.test.mts
node --experimental-strip-types scripts/tool-metadata.mts
~~~

offline例は同梱の架空入力を実adapterとrunnerへ渡し、生成した返答を注入します。HTTP要求・API料金は0です。結果にはinjected_transportとoffline-generated-fixtureを記録し、最後のtraceをメモリ上で読み戻します。これは本番モデルの回答や永続Storeの資格検証ではありません。

元の対象試験はnpm testで実行できます。N02の215/215試験・本番READY・認証付き実callは既存証拠を保持します。このsource公開ではそれを全件繰り返しません。

## 自分のserviceで使う

これは既存Pluginを利用する手順とは別です。自己ホストでは自分のTypeSafe利用契約とNetlify設定が必要です。設定例は [.env.example](.env.example) 、既存の認証型と処理はnetlify/lib/auth.mtsを参照します。キーや有効な認証値をこのtreeへ保存しません。

まず固定HTTPS originを設定します。

~~~sh
node scripts/configure-origin.mjs https://your-service.example
~~~

この操作は二つのorigin placeholderだけを変更します。Netlify側でTYPESAFE_API_KEYと既存形式のJEV_AUTH_CONFIGを設定し、通常の自己ホストdeploy手順を使います。有限toolはJEV_FABRIC_ENABLEDとJEV_FABRIC_PLAN_ENABLEDの両方がtrueのときに列挙されます。現在の運用siteへこの例を無条件deployしないでください。

## Sourceの対応と保守

[PROVENANCE.json](PROVENANCE.json) にFabric source、recovery base、二つのpatchのhashとファイルごとの対応を記録します。core・adapter・質問定義・MCP実行部は組立済みです。公開用変更はorigin template、説明、架空例、依存lock、配布検査に限定しています。lockは今回生成したもので、本番lockとのbyte一致は主張しません。

LICENSEの扱いは [LICENSE](LICENSE) 、第三者依存は [NOTICE.md](NOTICE.md) 、秘密と報告経路は [SECURITY.md](SECURITY.md) を確認してください。Jevのモデル重みや学習データ、私的資料、会話全文は同梱しません。

Single-ref transportとReversible change coreは独立した低レベル部品です。このtreeはJevをその必須依存へ追加しません。Clef・Decisions・Fugu・学習したprovider選択や、過去のconsumer実験の全採用を、この版の提供機能へ数えません。

## 今回の公開と運用の境界

公開集合はPUBLIC_ALLOWLIST.jsonの41本文と、allowlist・manifestの2生成記録だけです。非公開adaptive source、私有artifact、会話、productionの設定値・認証値は含めていません。公開時にLICENSEの未許諾本文を維持しています。

既存N02の運用証拠と、この配布sourceの非課金offline consumer試行は別です。R1/R2とR3の局所subsetは公開集合へ追加していません。R3の実consumer/CLI、Store/HTTP cutoff、durable ownerと実環境資格はOPENです。
