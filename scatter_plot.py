"""绘制散点图示例脚本。

生成随机数据并用 matplotlib 绘制散点图，保存为 scatter_plot.png 并展示。
"""

import numpy as np
import matplotlib.pyplot as plt

# 设置随机种子，保证结果可复现
rng = np.random.default_rng(42)

# 生成随机数据
n = 100
x = rng.normal(50, 15, n)
y = rng.normal(60, 20, n)
colors = rng.uniform(0, 1, n)
sizes = rng.uniform(20, 200, n)

# 绘制散点图
plt.figure(figsize=(8, 6))
plt.scatter(x, y, c=colors, s=sizes, alpha=0.7, cmap="viridis", edgecolors="black", linewidths=0.5)
plt.colorbar(label="颜色值")
plt.xlabel("X 值")
plt.ylabel("Y 值")
plt.title("随机数据散点图")
plt.grid(True, linestyle="--", alpha=0.5)

# 保存并显示
plt.savefig("scatter_plot.png", dpi=150, bbox_inches="tight")
plt.show()
print("散点图已生成并保存为 scatter_plot.png")
