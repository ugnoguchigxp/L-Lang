// biome-ignore-all lint/style/noNonNullAssertion: Loop bounds guarantee valid typed-array indices; keep benchmark kernels free of extra checks.
export const algorithms = [
  "insertion",
  "selection",
  "bubble",
  "shell",
  "heap",
] as const;
export type Algorithm = (typeof algorithms)[number];

function swap(a: Int32Array, i: number, j: number) {
  const value = a[i]!;
  a[i] = a[j]!;
  a[j] = value;
}

export const sorts: Record<Algorithm, (a: Int32Array) => void> = {
  insertion(a) {
    for (let i = 1; i < a.length; i++) {
      const value = a[i]!;
      let j = i;
      while (j > 0 && a[j - 1]! > value) {
        a[j] = a[j - 1]!;
        j--;
      }
      a[j] = value;
    }
  },
  selection(a) {
    for (let i = 0; i < a.length - 1; i++) {
      let min = i;
      for (let j = i + 1; j < a.length; j++) {
        if (a[j]! < a[min]!) min = j;
      }
      swap(a, i, min);
    }
  },
  bubble(a) {
    for (let end = a.length - 1; end > 0; end--) {
      let changed = false;
      for (let i = 0; i < end; i++) {
        if (a[i]! > a[i + 1]!) {
          swap(a, i, i + 1);
          changed = true;
        }
      }
      if (!changed) break;
    }
  },
  shell(a) {
    for (
      let gap = Math.floor(a.length / 2);
      gap > 0;
      gap = Math.floor(gap / 2)
    ) {
      for (let i = gap; i < a.length; i++) {
        const value = a[i]!;
        let j = i;
        while (j >= gap && a[j - gap]! > value) {
          a[j] = a[j - gap]!;
          j -= gap;
        }
        a[j] = value;
      }
    }
  },
  heap(a) {
    function sift(root: number, n: number) {
      while (root * 2 + 1 < n) {
        let child = root * 2 + 1;
        if (child + 1 < n && a[child]! < a[child + 1]!) child++;
        if (a[root]! >= a[child]!) break;
        swap(a, root, child);
        root = child;
      }
    }
    for (let i = Math.floor(a.length / 2) - 1; i >= 0; i--) sift(i, a.length);
    for (let end = a.length - 1; end > 0; end--) {
      swap(a, 0, end);
      sift(0, end);
    }
  },
};
