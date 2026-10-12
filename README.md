# Jev Decision Fabric

普通の仕事を、hostが保有するplanner・decision・worker・tool・finalの接続で実行するSDKと、既存の有限判断MCP serverです。[公開source](https://github.com/Yuliasiris/jev-decision-fabric)のproject-authored codeと文書は[MIT License](LICENSE)で再利用できます。第三者依存とJev serviceの権利は[NOTICE.md](NOTICE.md)で分けています。

SDKは利用者の依頼、source view、利用可能なcapability、親の予算・期限を受け取り、同じControllerへ仕事を組みます。hostが実行した結果を観測として採用し、plannerが残りの仕事を提案します。checkpointの保存とwriter fence、開始済みeffectの照合を持つhostは、中断したrunを復旧できます。特定のDot・LLM・ScienceLabを必要としません。

公開SDKのcodeとhostを実際に接続した証拠は別です。reference examplesはscripted local plannerと実際のlocal file I/Oを使います。これをlive Jev、native caller、二つの認証済みproduction host、第三者導入の完走と呼びません。比較にもscripted/injectedと実測を記録し、値が無いusage/cost/latencyはnullのまま残します。

## SDKを導入する

Node 22.13以上とnpmが必要です。公開sourceをcloneし、その公開refを記録して使います。

~~~sh
git clone https://github.com/Yuliasiris/jev-decision-fabric.git
cd jev-decision-fabric
git rev-parse HEAD
npm ci --ignore-scripts
npm run build:sdk
npm run verify:sdk-package
~~~

`build:sdk`はNode標準APIで公開SDKのTypeScriptを`dist/`のJavaScriptへ変換します。既lockに含まれるTypeScript 5.9.3でstrict型検査と `.d.mts` 型宣言を生成します。新しいdependencyは追加していません。provider、worker、credentialを呼び出しません。 reference hostはbuild後の `dist/examples/work-sdk.mjs` と `work-stdio.mjs` から実行できます。private state directoryと保存pause/restart手順はSDK guideにあります。`verify:sdk-package`はnpmの配布ファイル一覧をfresh consumerの`node_modules`へコピーし、公開exportsをimportし、通常のTypeScript consumerもemit・実行します。dependency installやprovider callは行いません。

アプリへ入れる場合は、buildした同じrefからtarballを作れます。

~~~sh
npm pack --ignore-scripts
# 作成されたtarballを、利用側のprojectから指定する
npm install /path/to/jev-decision-fabric-0.4.0-preview.5.tgz --ignore-scripts
~~~

registry上の同名packageの公開を前提にしません。導入・ports・保存と再開は[SDK guide](docs/SDK.md)、権限と接続は[host connections](docs/HOST_CONNECTIONS.md)を参照してください。

~~~js
import {createWork, restoreWork, WorkRun} from 'jev-decision-fabric';
import {Controller} from 'jev-decision-fabric/controller';
import {runPairedComparison} from 'jev-decision-fabric/evaluation';
~~~

## 自分のCSVを保存して続行する

候補JSONを手入力せず、普通の依頼とCSVから件数・合計・重複ラベルを確認する利用例は [CSV consumer](docs/CSV_CONSUMER.md) にあります。公開packageのexportsとNode標準APIを使い、開始後に保存して、別processから元のrun・期限・予算で続行できます。結果は入力SHAと観測を含みます。plannerとfinalはローカルのscripted recipeです。

普通のstdio parentは [MCP parent guide](docs/MCP_PARENT.md) の `--format text` で回答・現在の確認状態・安全な次操作を表示できます。`--operation inspect` は保存済みclient記録を接続なしで読みます。request IDを省略すると開始前に保存し、同じ依頼の再入場で再利用します。JSON出力も利用できます。

## Interfaceの選び方

|Interface|利用できること|接続と観測|
|---|---|---|
|SDK `createWork` / `restoreWork`|普通の依頼、host plannerと仕事の実行、観測採用、snapshotと復旧|hostが実ports・source/read権限・保存・fenceをbindする|
|host-bound MCP work adapter|start / continue / status / cancelのversioned work tools|hostのserviceとtrusted transportがある時だけ列挙。SDKと同じrunを扱う|
|既存MCP `decision_evaluate`|固定4質問セットの一回判断|既存OAuthとTypeSafe Jev接続|
|既存MCP `decision_run_v1`|固定4質問セットの有限plan|実際に列挙される接続で使う。各stepの同じJevは別providerではない|
|既存Plugin|上記の固定2toolと既存Skill|汎用work toolsの配送を意味しない。使用中のtool一覧を確認する|

host-bound MCPには`work_start_v1`、`work_continue_v1`、`work_status_v1`、`work_cancel_v1`があります。既存Netlify serverのroute、OAuth redirect、scope、flagをこのSDK導入で変更しません。詳しくは[interfaces](docs/INTERFACES.md)。

## 比較して方式を選ぶ

`runPairedComparison`へ同じ入力・source・予算条件とsingle/fixed/adaptiveの実runnerを渡します。元のusage receiptをhostが独立にattestし、finalを評価するためのportsも渡します。scripted/injectedは`diagnostic_only`、条件不一致は`invalid`、必要な原記録が取得できない場合は`unavailable`として区別します。unknown gainからadaptiveを推奨しません。scopeを満たす結果から作ったpolicy profileは、fresh admissionと現在のauthorityを照合して消費します。profileのJSONだけで接続や権限を発行しません。
実APIと記録の条件は[comparison guide](docs/COMPARISON.md)にあります。

## 既存の固定判断server

TypeSafe Jevへ必要な観測だけを送り、native Choice・Noulを助言として扱います。

|質問セット|使う範囲|
|---|---|
|ops-liveness-v0|run・保存・返却・消費・局所阻害の観測|
|roi-delta-v0|変更された競馬FACTが既存分析へ及ぼす影響|
|music-routing-v0|解析観測と制作意図から次の処理を検討|
|synthetic-smoke-v0|一回の接続確認用fixture|

既存の使い方は[Decision Fabric skill](skills/decision-fabric/SKILL.md)、有限判断契約は[FABRIC.md](FABRIC.md)です。この固定interfaceは自由質問、原音採譜、歌詞認識、勝率算出、自動Applyを提供しません。custom SDK/J1依頼を旧質問のstateに埋め込んで代用しません。

従来のoffline例はそのまま利用できます。

~~~sh
node --experimental-strip-types examples/offline.mts
node --experimental-strip-types --test test/release.test.mts
node --experimental-strip-types scripts/tool-metadata.mts
~~~

offline例は架空入力と注入返答を使い、HTTP要求・API料金は0です。メモリtraceのfinish読戻しは本番モデルの回答やdurable Storeの資格検証ではありません。N02の215件・本番READY・認証付き実callは、その元のscopeに属する既存証拠です。

自己hostでは自分の正規TypeSafe connectionとNetlify設定を使います。source repoの[設定名例](.env.example)とauth.mtsを参照し、固定originを設定します。

~~~sh
node scripts/configure-origin.mjs https://your-service.example
~~~

この操作は二つのorigin placeholderだけを変更します。既存OAuthはChatGPT用redirectのままです。一般CLIへ無条件にOAuthを拡張する手順ではありません。SDKを自分のhost内の正規connection callbackへつなぐ導入路は別に説明しています。
既存TypeSafe connectionの一回選択adapterは[TypeSafe guide](docs/TYPESAFE.md)にあります。hostの元allocationと実current grantを照合し、一回のphysical POST・retry0を維持します。接続codeの公開だけで現在のJ1実host handlesが提供されたとは扱いません。

## Source・権利・資格

[PROVENANCE.json](PROVENANCE.json)、[public allowlist](PUBLIC_ALLOWLIST.json)、[source manifest](SOURCE_MANIFEST.sha256)が配布sourceを記録します。Oct9の43-file公開は閲覧sourceのhistorical releaseです。今回追加したSDK、比較、MCP adapterとMIT grantは同じ履歴に独立したscopeとして記録します。元の本番function/lockとのbyte一致やruntimeの導入は、それぞれの実観測が必要です。

[CHANGELOG.md](CHANGELOG.md)、[release scope](docs/RELEASE_SCOPE.md)、[SECURITY.md](SECURITY.md)を確認できます。私的会話、原資料、character sources、運用credential、model weights、training dataを含めません。

普通のparentからstdio hostへ依頼し、保存・再入場・状態読戻しを行う公開client例は [MCP parent guide](docs/MCP_PARENT.md) にあります。これは既bounded local reference hostを使い、実LLM／Jevや別の認証済hostのqualificationを追加するものではありません。
