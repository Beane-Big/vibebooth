// 设置密码时要输入两次：passwordRules 校验长度，confirmRules 校验和 password 字段一致。管理员重置密码和本人改密码共用。
export const passwordRules = [
  { required: true, message: "请输入密码" },
  { min: 8, message: "密码至少 8 位" },
];
export const confirmRules = [
  { required: true, message: "请再输入一次密码" },
  ({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
    validator: (_: unknown, value: string) =>
      !value || value === getFieldValue("password") ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一样")),
  }),
];
