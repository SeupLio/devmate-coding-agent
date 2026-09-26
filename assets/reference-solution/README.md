# mathutils

一个数学工具库（参考解版本，用于评测灵敏度实验的基线）。

## API 说明

| 函数 | 签名 | 说明 |
|---|---|---|
| `sum` | `sum(nums: number[])` | 返回数组元素之和，空数组返回 0 |
| `average` | `average(nums: number[])` | 返回数组平均值，空数组返回 0 |
| `fibonacci` | `fibonacci(n: number)` | 返回第 n 项斐波那契数（迭代实现），n < 0 抛 `RangeError` |
| `maxOf` | `maxOf(nums: number[])` | 返回数组最大值 |
| `clamp` | `clamp(x, lo, hi)` | 将 x 限制在 `[lo, hi]` 区间内 |

## 运行测试

```bash
node --test
```
