export default {
  extends: ['@commitlint/config-conventional'],
  // dependabot 的提交体带长 URL（Bumps [...] 链接行恒超 100 列）——bot 提交不适用
  // 人类的 body 纪律，按签名忽略；自写提交仍受全量规则约束（roadmap 依赖分诊纪律配套）。
  ignores: [(commit) => commit.includes('Signed-off-by: dependabot[bot]')],
};
