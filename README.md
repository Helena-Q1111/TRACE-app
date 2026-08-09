# TRACE Visualizer

**TRACE** (Tension-Regularized Auto-encoded Chord Embeddings) 的桌面可视化器：导入一个 MIDI 文件，识别其中的和弦进行，在模型学到的 3D 张力潜空间中以星际航行的方式播放整首曲子的和声轨迹。

---

## 一、TRACE 模型是什么

### 核心假设

> 用一个模拟人类短时记忆的"局部认知滑窗"（8 个和弦，窗口内移调到关系大调），把 15 维复合和弦特征经最简单的 MLP 自编码器压缩到 3 维；训练时仅用 MSE 强制**相邻和弦的 3D 物理距离逼近 Lerdahl TPS（Tonal Pitch Space）理论距离**。这样一个极简模型能否自动涌现出与人类听觉心理学高度对齐的几何拓扑？

### 输入表示（15 维）

| 维度 | 内容 |
|---|---|
| 0–11 | 加权 Chroma：根音 1.0，其他和弦音 0.5（v2 表中低音≠根音时低音 0.75） |
| 12–13 | 根音圆周编码 `[sin(2πr/12), cos(2πr/12)]` |
| 14 | 对数时值 `log(1+duration)` |

### 架构与损失

```
Encoder: Linear(15,64) → ReLU → Linear(64,32) → ReLU → Linear(32,3)
Decoder: 对称反向，Chroma 用 Sigmoid、圆周编码 L2 归一化回单位圆

Loss = 重构 MSE + λ · TPS 距离损失
TPS 距离 δ = γj·j + γk·k
  j = 两和弦根音在五度圈上的环形最短距离 (0–6)
  k = 两和弦音级集合的对称差（不重合音数）
```

编码器是逐和弦独立的（无上下文），所以每个 (root, bass, pcs) 组合有唯一确定的 3D 坐标——这是"查表即可视化"的前提。全部实现在 `scripts/autoencoder.py` / `scripts/train_ae.py`。

### 关键结果

与人类听觉张力评分（心理声学测试）的 Spearman 相关：

| 模型 | ρ | p |
|---|---|---|
| M0 无约束 AE（vanilla） | **−0.365**（反向！） | 0.10（不显著） |
| **M2 TPS 约束 AE（TRACE）** | **+0.577** | **0.006** |

纯重构目标学到的几何与人类认知**相反**；加入 TPS 归纳偏置后翻转为显著正相关（+258%）。详见根目录 `OUTCOME.md` / `FINAL_RESULTS.md`。

---

## 二、这个软件做什么

单个 MIDI 文件进来，完整流水线全部在前端完成：

```
MIDI 导入 → 多轨解析(tempo/拍号) → 和弦识别(27模板+逐小节DP分段)
→ 调性判定(K-S 猜调，可手动改调/加转调点) → 移调到 C → 查 embedding 表
→ 3D 轨迹渐进播放(Three.js) + 钢琴音频(Tone.js) + 五度圈张力雷达 + 视频导出
```

主要功能一览（每个功能的详细逻辑见 **[features.md](features.md)**）：

- **3D 和声轨迹**：和弦按 embedding 坐标（sinh 对比度重映射）逐个点亮，路径线的粗细/亮度分四档编码张力大小；I 级参考信标常驻，离调和弦有更亮的光晕；级数（RNA 罗马数字）标签悬浮于每个和弦上方
- **五度圈张力雷达**（右上角）：12 音按五度圈排列，调性中心转到正上方（转调有旋转动画）；和弦落在根音轴上，半径 = 到 I 级的张力距离（全曲分位数均衡归一化），同屏 5 个和弦渐隐拖尾
- **调性系统**：自动猜调 + 侧栏确认，支持"第 N 小节转调"多段标记，级数与坐标随之重算
- **播放**：Salamander 钢琴采样、空格播放/暂停、音画严格同步（暂停/跳转/循环都对齐）
- **视频导出**：一键从头录制整曲（画面+声音），优先 H.264+AAC MP4，自动回退 WebM，产物带字节级编码自检
- **外观**：和弦配色两步选择（功能三色/大小四色 × 三种色调）、深空/纸白主题、星星密度/线宽/轨迹淡出滑条

## 三、快速开始

### 桌面应用（推荐）

```bash
cd webapp/app
npm install        # 首次
npm start          # 启动
npm run dist       # 打包单文件 exe → webapp/build/
```

### 浏览器模式

```bash
python webapp/server.py 8123
# 打开 http://localhost:8123/app/renderer/index.html
```

（浏览器下 embedding 表经 fetch 加载，钢琴采样加载失败时自动降级为合成器音色。）

## 四、目录结构

```
webapp/
  app/
    main.js, preload.js      Electron 主进程 + IPC（读 JSON/二进制）
    renderer/
      index.html             页面骨架
      css/style.css
      js/
        config.js            常量、配色、调性/级数工具、共享状态
        analysis.js          和弦识别（模板打分 + DP 分段）+ K-S 猜调
        chords.js            embedding 查询、progression 构建、3D 轨迹渲染
        scene.js             相机/灯光/后期(Bloom)
        cosmos.js            星空/星云/尘埃背景
        particles.js         粒子工具与和弦粒子云
        playback.js          MIDI 解析 + 钢琴采样播放
        radar.js             五度圈张力雷达
        export.js            视频导出
        ui.js                侧栏/快捷键/外观控件
        app.js               入口 + 动画主循环
      vendor/                three.js r128、Tone.js、tween、midi-parser、钢琴采样（全离线）
      data/embedding_table_v2.json   159,744 项 (root:bass:[pcs]) → 3D 坐标
  generate_table_v2.py       用训练好的模型重新导出 embedding 表
  server.py                  浏览器模式静态服务器
  build/                     npm run dist 的 exe 产物
```

## 五、Embedding 表

`embedding_table_v2.json`（8.6MB，159,744 项）由 `generate_table_v2.py` 从 `outputs/output_ae/best_model.pt` 导出，覆盖**所有**包含根音的音级子集 × 子集内任意低音，键格式 `"root:bass:[sorted pcs]"`。低音感知编码（bass≠root 时 chroma[bass]=0.75）让转位拥有独立坐标。

换了新 checkpoint 后重新导出并拷入 `app/renderer/data/`：

```bash
python webapp/generate_table_v2.py
```

所有 embedding 都以 C 为基准；运行时按当前调把 (root, bass, pcs) 移调到 C 再查表（小调对齐关系大调）。

## 六、遗留文件说明

- `midi_to_chords.py` / `chord_table.json` / `*_progression.json`：v1 时代的 Python 离线识谱流水线与背景星座表，**当前 app 已不使用**（识别全部在前端完成），保留仅供参考
- `embedding_table.json`（2.7MB）：不含低音信息的 v1 表，已被 v2 取代

## License

Research project. Use and modify freely for academic/personal purposes.
