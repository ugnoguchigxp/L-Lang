# Variable-length order batch

This example uses the `module-collection-v1` profile. Equivalent TypeScript and
JSONC modules filter a variable-length list, capture the threshold in a
callback, stable-sort the retained values, and fold them into a total.

```sh
bun run llang module test application/evaluate.ts \
  --root examples/module-order-batch --entry evaluate \
  --suite examples/module-order-batch/suite.json \
  --profile module-collection-v1
```
