import { useState } from "react";
import { App as AntApp, Button, Card, Col, Flex, Row, Segmented, Space, Steps, Typography } from "antd";
import { CopyOutlined, DownloadOutlined, RocketOutlined } from "@ant-design/icons";
import { skillUrl } from "./api";

type ToolKey = "claude" | "cursor" | "codex" | "antigravity" | "other";

const toolGuides: Record<ToolKey, { label: string; path: string; step: string }> = {
  claude: {
    label: "Claude Code",
    path: "~/.claude/skills/vibebooth-app-dev/",
    step: "解压后把 vibebooth-app-dev 文件夹放进上述目录（或项目内 .claude/skills/），对话时告诉 AI 使用 vibebooth-app-dev skill。",
  },
  cursor: {
    label: "Cursor",
    path: "~/.cursor/skills/vibebooth-app-dev/",
    step: "解压后放进上述目录（或项目内 .cursor/skills/），在对话框里让 AI 按 vibebooth-app-dev skill 开发。",
  },
  codex: {
    label: "Codex",
    path: "~/.codex/skills/vibebooth-app-dev/",
    step: "解压后放进上述目录（或项目内 .agents/skills/），在指令里让它使用 vibebooth-app-dev skill。",
  },
  antigravity: {
    label: "Antigravity",
    path: ".agent/skills/vibebooth-app-dev/",
    step: "在界面导入解压后的 vibebooth-app-dev 文件夹，或放进项目 .agent/skills/ 目录即可。",
  },
  other: {
    label: "其他 AI 工具",
    path: "vibebooth-app-dev/SKILL.md",
    step: "把解压后的目录放进空文件夹，对话时先让 AI 阅读 vibebooth-app-dev/SKILL.md，再按规范开发并打包。",
  },
};

const promptTemplates = [
  {
    title: "日常小工具",
    prompt:
      "使用 vibebooth-app-dev skill，帮我开发一个「随机菜谱」应用：录入平时常做的菜，一键随机决定今天吃什么，支持手机使用，界面简洁好看。完成后按 skill 规范自检并打包好上传用的压缩包。",
  },
  {
    title: "个人记录与打卡",
    prompt:
      "使用 vibebooth-app-dev skill，帮我开发一个「每日打卡」应用：可以新建习惯、每天点一下打卡、看最近的打卡记录，每个人登录后只看到自己的数据。完成后按 skill 规范自检并打包好上传用的压缩包。",
  },
  {
    title: "家庭协作应用",
    prompt:
      "使用 vibebooth-app-dev skill，帮我开发一个「家庭购物清单」应用：家人登录后可以共同添加待买物品、勾选已买，有新添加的物品时可以给相关成员发一条消息提醒。完成后按 skill 规范自检并打包好上传用的压缩包。",
  },
  {
    title: "给已有应用加新功能",
    prompt:
      "使用 vibebooth-app-dev skill，给当前应用新增【填写想要的新功能】，保留原来的数据，改完后自动调高版本号并重新打包成上传用的压缩包。",
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
              description: "获取开发规范与自动打包工具",
            },
            {
              title: "交给 AI 生成并打包",
              status: "wait",
              description: "说出需求，自动输出压缩包",
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

      <Card title="把 Skill 放入 AI 工具">
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

      <Card title="常用提示词示例">
        <Row gutter={[12, 12]}>
          {promptTemplates.map((item) => (
            <Col xs={24} md={12} key={item.title}>
              <Card
                size="small"
                title={item.title}
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

      <Card size="small" title="小贴士">
        <Flex vertical gap={6}>
          <Typography.Text type="secondary">
            1. 构建或安装出错时，在「应用构建」展开失败日志，点「复制给 AI 修复」粘回对话框即可让 AI 自动修改。
          </Typography.Text>
          <Typography.Text type="secondary">
            2. 升级应用时只要保持应用标识不变、调高版本号，原来存好的数据会自动保留。
          </Typography.Text>
          <Typography.Text type="secondary">
            3. 安装完成后，可在「应用管理」设置是否允许访客公开访问，在「联系人」给成员分配使用权限。
          </Typography.Text>
        </Flex>
      </Card>
    </Flex>
  );
}
