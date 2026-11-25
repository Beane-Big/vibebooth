import { useState } from "react";
import { App as AntApp, Button, Card, Col, Flex, Row, Segmented, Space, Steps, Tag, Typography } from "antd";
import { CopyOutlined, DownloadOutlined, RocketOutlined } from "@ant-design/icons";
import { skillUrl } from "./api";

type ToolKey = "claude" | "cursor" | "codex" | "antigravity" | "other";

const toolGuides: Record<ToolKey, { label: string; path: string; step: string }> = {
  claude: {
    label: "Claude Code",
    path: "~/.claude/skills/vibebooth-app-dev/",
    step: "解压后将整个 vibebooth-app-dev 文件夹放入上述目录（或项目内 .claude/skills/），对话时直接要求使用 vibebooth-app-dev skill。",
  },
  cursor: {
    label: "Cursor",
    path: "~/.cursor/skills/vibebooth-app-dev/",
    step: "解压后放入上述目录（或项目内 .cursor/skills/），在对话框中说明按 vibebooth-app-dev 规范开发。",
  },
  codex: {
    label: "Codex",
    path: "~/.codex/skills/vibebooth-app-dev/",
    step: "解压后放入上述目录（或项目内 .agents/skills/），在任务指令中引用 vibebooth-app-dev skill。",
  },
  antigravity: {
    label: "Antigravity",
    path: ".agent/skills/vibebooth-app-dev/",
    step: "在界面导入解压后的 vibebooth-app-dev 文件夹，或放进项目 .agent/skills/ 目录即可自动识别。",
  },
  other: {
    label: "其他 AI 工具",
    path: "vibebooth-app-dev/SKILL.md",
    step: "将解压后的目录放进空项目，对话时先让 AI 阅读 vibebooth-app-dev/SKILL.md，再按规范开发并运行打包脚本。",
  },
};

const promptTemplates = [
  {
    title: "纯前端小工具",
    tag: "0 级 · 免后端",
    color: "green",
    prompt:
      "使用 vibebooth-app-dev skill，帮我开发一个「宝宝辅食与日常记录」纯前端应用（0 级），数据存在浏览器本地，适配手机和平板，界面简洁克制。写完后运行 skill 里的 check-and-pack.mjs 自检并生成源码包。",
  },
  {
    title: "带云同步的个人应用",
    tag: "2 级 · 按人存数据",
    color: "blue",
    prompt:
      "使用 vibebooth-app-dev skill，帮我开发一个「家庭账本 / 每日打卡」应用（2 级，React + Go + SQLite），按登录账号隔离各自数据，支持手机端操作。写完后运行 check-and-pack.mjs 自检并打包为源码包。",
  },
  {
    title: "意见箱 / 留言板",
    tag: "4 级 · 接入消息推送",
    color: "purple",
    prompt:
      "使用 vibebooth-app-dev skill，帮我开发一个「意见箱」应用：所有用户可提交建议并查看回复，管理员可管理与回复；收到新建议或管理员回复时调用 Vibebooth 消息推送接口提醒对方。完成后运行 check-and-pack.mjs 打包。",
  },
  {
    title: "升级已有应用",
    tag: "保留数据升级",
    color: "orange",
    prompt:
      "按 vibebooth-app-dev skill 规范修改当前应用，新增【填写你要加的功能】。注意保持 module.yaml 里的 id 不变、调大 version、数据库变更兼容旧数据，改完运行 check-and-pack.mjs 重新打包。",
  },
];

export default function AppDevGuide({ onGoBuild }: { onGoBuild: () => void }) {
  const { message } = AntApp.useApp();
  const [tool, setTool] = useState<ToolKey>("claude");
  const activeTool = toolGuides[tool];

  async function copy(text: string, tip = "已复制") {
    try {
      await navigator.clipboard.writeText(text);
      message.success(tip);
    } catch {
      message.error("复制失败");
    }
  }

  return (
    <Flex vertical gap={16} style={{ maxWidth: 960 }}>
      <Card title="三步开发并上架应用">
        <Steps
          responsive
          items={[
            {
              title: "下载开发 Skill",
              status: "process",
              description: "获取平台规范与自检打包脚本",
            },
            {
              title: "交给 AI 生成并打包",
              status: "wait",
              description: "描述需求，自动输出 source.zip",
            },
            {
              title: "上传构建并安装",
              status: "wait",
              description: "拖入「应用构建」一键部署",
            },
          ]}
          style={{ marginBottom: 20 }}
        />
        <Space wrap>
          <Button type="primary" href={skillUrl} icon={<DownloadOutlined />}>
            下载开发 Skill（.zip）
          </Button>
          <Button onClick={onGoBuild} icon={<RocketOutlined />}>
            前往应用构建
          </Button>
        </Space>
      </Card>

      <Card title="把 Skill 放入 AI 编程工具">
        <Flex vertical gap={12}>
          <Segmented
            value={tool}
            onChange={(v) => setTool(v as ToolKey)}
            options={Object.entries(toolGuides).map(([value, item]) => ({ value, label: item.label }))}
            style={{ alignSelf: "flex-start" }}
          />
          <Flex align="center" gap={8} wrap>
            <Typography.Text code>{activeTool.path}</Typography.Text>
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              onClick={() => copy(activeTool.path, "已复制路径")}
            >
              复制路径
            </Button>
          </Flex>
          <Typography.Text type="secondary">{activeTool.step}</Typography.Text>
        </Flex>
      </Card>

      <Card title="常用提示词模板">
        <Row gutter={[12, 12]}>
          {promptTemplates.map((item) => (
            <Col xs={24} md={12} key={item.title}>
              <Card
                size="small"
                title={
                  <Space size={6}>
                    <span>{item.title}</span>
                    <Tag color={item.color}>{item.tag}</Tag>
                  </Space>
                }
                extra={
                  <Button
                    size="small"
                    type="link"
                    icon={<CopyOutlined />}
                    onClick={() => copy(item.prompt, "已复制提示词")}
                  >
                    复制
                  </Button>
                }
                style={{ height: "100%" }}
              >
                <Typography.Paragraph style={{ marginBottom: 0, fontSize: 13 }}>
                  {item.prompt}
                </Typography.Paragraph>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      <Card size="small" title="要点">
        <Flex vertical gap={6}>
          <Typography.Text type="secondary">
            1. 构建或安装报错时，在「应用构建」展开失败日志，点击「复制给 AI 修复」粘回对话框即可闭环修正。
          </Typography.Text>
          <Typography.Text type="secondary">
            2. 升级应用时保持 module.yaml 中的 id 不变、调大 version，原有数据卷会自动保留。
          </Typography.Text>
          <Typography.Text type="secondary">
            3. 安装完成后，可在「应用管理」调整该应用的公开访问范围，在「联系人」分配成员权限。
          </Typography.Text>
        </Flex>
      </Card>
    </Flex>
  );
}
