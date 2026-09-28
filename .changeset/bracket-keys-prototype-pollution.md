---
"@dudousxd/nestjs-filter": patch
---

Security: bracket-key expansion no longer allows prototype pollution. A query string such as `?filter[__proto__][polluted]=1` (or `filter[constructor][prototype][x]=1`) used to assign onto `Object.prototype` when the runner expanded Express 5's flat bracket keys. Keys whose path contains `__proto__`, `constructor` or `prototype` are now dropped, a bare `__proto__` key is no longer copied, and array indices above 1000 are dropped instead of allocating a huge sparse array.
