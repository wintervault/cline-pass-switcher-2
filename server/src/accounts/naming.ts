/** 账号名长度上限，与 `config/schema.ts` 的 AccountSchema 保持一致。 */
const MAX_NAME = 50;

export interface AccountRename {
  from: string;
  to: string;
}

/**
 * 强制账号名唯一（3.0 §9 第 9 条：账号的标识是 `name`）。
 *
 * metadata 里的用量统计与风控分类都按账号名存，重名会让两个账号的观测数据
 * 混在一起（`stats['主力']` 分不清是哪一个）。所以在**加载**与**保存**两处
 * 都要收敛：保留先出现的那个，后面的自动改名——改名在 UI 上看得见，
 * 密钥与到期时间都不丢（比丢弃温和）。
 */
export function ensureUniqueAccountNames<T extends { name: string }>(
  accounts: readonly T[],
): { accounts: T[]; renamed: AccountRename[] } {
  const seen = new Set<string>();
  const renamed: AccountRename[] = [];
  const out = accounts.map((account) => {
    const base = account.name.trim().slice(0, MAX_NAME) || '账号';
    let name = base;
    for (let n = 2; seen.has(name); n += 1) {
      const suffix = `-${n}`;
      name = `${base.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    }
    if (name !== account.name) renamed.push({ from: account.name, to: name });
    seen.add(name);
    return name === account.name ? account : { ...account, name };
  });
  return { accounts: out, renamed };
}

/** 账号名列表的唯一化（迁移时只需要名字，不需要完整账号对象）。 */
export function uniqueAccountNames(names: readonly string[]): string[] {
  return ensureUniqueAccountNames(names.map((name) => ({ name }))).accounts.map((a) => a.name);
}
