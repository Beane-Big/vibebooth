import { useEffect, useState } from "react";
import { Alert, App as AntApp, Button, Card, Col, Empty, Flex, Popconfirm, Row, Segmented, Statistic, Table, Tag, Tooltip, Typography, theme } from "antd";
import { api, type StatsDays, type StatsReport } from "../api";
import { builtinApps } from "../builtin";
import SwitchRow from "../components/SwitchRow";

// 平台自带的“统计”应用，只给管理员：打开或关闭活跃度统计，看最近 7、30、90 天谁在用平台、用哪些应用、用了多久。
// 数据怎么来的见 core/stats.go 和 activity.ts。onChanged 在开关变了以后让门户重新取自己的账号信息（顶栏的提示跟着变）。
export default function Stats({ onChanged }: { onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const [days, setDays] = useState<StatsDays>(30);
  const [report, setReport] = useState<StatsReport | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .stats(days)
      .then((r) => {
        setReport(r);
        setError("");
      })
      .catch((err) => setError(err.message));
  }
  useEffect(load, [days]);

  async function toggle(enabled: boolean) {
    setSaving(true);
    try {
      await api.setStatsEnabled(enabled);
      message.success(enabled ? "已开始记录活跃度" : "已停止记录，已有的数据保留");
      load();
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    try {
      await api.clearStats();
      message.success("统计数据已清空");
      load();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "清空失败");
    }
  }

  return (
    <Flex vertical gap={16}>
      <Card styles={{ body: { paddingBlock: 6 } }}>
        <SwitchRow
          title="记录活跃度"
          description="打开后记录每个人什么时候用了哪个应用、用了多久，以及登录记录。只有管理员能看，明细保留 90 天，按天的汇总一直保留。每个人的头像菜单里会提示正在记录。"
          checked={report?.enabled ?? false}
          disabled={!report || saving}
          onChange={toggle}
          extra={
            <Popconfirm title="清空全部统计数据？" description="明细和按天的汇总都会删除，不能恢复。" okText="清空" okButtonProps={{ danger: true }} onConfirm={clear}>
              <Button size="small" danger>
                清空数据
              </Button>
            </Popconfirm>
          }
        />
      </Card>
      {error && <Alert type="error" message={error} showIcon />}
      {report && <Report report={report} days={days} onDays={setDays} />}
    </Flex>
  );
}

function Report({ report, days, onDays }: { report: StatsReport; days: StatsDays; onDays: (d: StatsDays) => void }) {
  const empty = report.apps.length === 0;
  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="今天活跃" value={report.todayUsers} suffix="人" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="近 7 天活跃" value={report.weekUsers} suffix="人" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="近 30 天活跃" value={report.monthUsers} suffix="人" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="今天使用" value={formatMinutes(report.todayMinutes)} />
          </Card>
        </Col>
      </Row>
      <Flex align="center" justify="space-between" gap={12} wrap>
        <Segmented<StatsDays>
          value={days}
          onChange={onDays}
          options={[
            { value: 7, label: "近 7 天" },
            { value: 30, label: "近 30 天" },
            { value: 90, label: "近 90 天" },
          ]}
        />
        <Typography.Text type="secondary">
          这段时间登录成功 {report.loginsOk} 次，失败 {report.loginsFailed} 次
        </Typography.Text>
      </Flex>
      {empty ? (
        <Card>
          <Empty description={report.enabled ? "这段时间还没有记录，有人用平台后过一两分钟就会出现。" : "活跃度统计没有打开，打开后开始记录。"} />
        </Card>
      ) : (
        <>
          <Card title="每天的使用时长" size="small">
            <DailyBars daily={report.daily} />
          </Card>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={14}>
              <AppsTable apps={report.apps} />
            </Col>
            <Col xs={24} lg={10}>
              <Devices devices={report.devices} />
            </Col>
          </Row>
          <PeopleTable people={report.people} />
        </>
      )}
    </>
  );
}

// DailyBars 是每天使用分钟数的柱状图，悬停看当天的人数和时长。只有一个系列，用主题的主色，不用图例。
function DailyBars({ daily }: { daily: StatsReport["daily"] }) {
  const { token } = theme.useToken();
  const max = Math.max(1, ...daily.map((d) => d.minutes));
  const label = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
  return (
    <div>
      <div className="stats-bars" style={{ gap: daily.length > 30 ? 1 : 2 }}>
        {daily.map((d) => (
          <Tooltip key={d.day} title={`${label(d.day)}：${d.users} 人，${formatMinutes(d.minutes)}`}>
            <div className="stats-bar-slot">
              <div
                className="stats-bar"
                style={{ height: `${(d.minutes / max) * 100}%`, background: token.colorPrimary }}
              />
            </div>
          </Tooltip>
        ))}
      </div>
      <Flex justify="space-between" style={{ marginTop: 6 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label(daily[0].day)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          最高 {formatMinutes(max)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label(daily[daily.length - 1].day)}
        </Typography.Text>
      </Flex>
    </div>
  );
}

// 统计里的应用名：首页和自带应用用门户自己的名称，模块用服务器给的名称，已卸载的模块只有 id。
function appName(app: StatsReport["apps"][number]) {
  if (app.app === "portal") return { name: "首页", tag: "" };
  const id = app.app.startsWith("portal:") ? app.app.slice("portal:".length) : "";
  if (id) return { name: builtinApps.find((b) => b.id === id)?.name ?? id, tag: "自带" };
  return app.name ? { name: app.name, tag: "" } : { name: app.app, tag: "已卸载" };
}

function AppsTable({ apps }: { apps: StatsReport["apps"] }) {
  return (
    <Card title="应用" size="small" styles={{ body: { padding: 0 } }}>
      <Table
        size="small"
        rowKey="app"
        pagination={false}
        dataSource={apps}
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: "应用",
            key: "app",
            render: (_, a) => {
              const { name, tag } = appName(a);
              return (
                <>
                  {name}
                  {tag && <Tag style={{ marginInlineStart: 8 }}>{tag}</Tag>}
                </>
              );
            },
          },
          { title: "使用人数", dataIndex: "users", align: "right", sorter: (a, b) => a.users - b.users },
          { title: "打开次数", dataIndex: "opens", align: "right", sorter: (a, b) => a.opens - b.opens },
          {
            title: "使用时长",
            dataIndex: "minutes",
            align: "right",
            defaultSortOrder: "descend",
            sorter: (a, b) => a.minutes - b.minutes,
            render: (m: number) => formatMinutes(m),
          },
        ]}
      />
    </Card>
  );
}

const deviceNames = { phone: "手机", tablet: "平板", desktop: "电脑" };

// Devices 是各类设备的使用时长占比，类别只有三种，用横条加文字，不用饼图。
function Devices({ devices }: { devices: StatsReport["devices"] }) {
  const { token } = theme.useToken();
  const total = devices.reduce((sum, d) => sum + d.minutes, 0);
  return (
    <Card title="设备" size="small">
      {devices.length === 0 ? (
        <Typography.Text type="secondary">没有记录</Typography.Text>
      ) : (
        <Flex vertical gap={12}>
          {devices.map((d) => {
            const share = Math.round((d.minutes / total) * 100);
            return (
              <div key={d.device}>
                <Flex justify="space-between">
                  <Typography.Text>{deviceNames[d.device] ?? d.device}</Typography.Text>
                  <Typography.Text type="secondary">
                    {formatMinutes(d.minutes)} · {share}%
                  </Typography.Text>
                </Flex>
                <div className="stats-meter" style={{ background: token.colorFillSecondary }}>
                  <div style={{ width: `${share}%`, background: token.colorPrimary }} />
                </div>
              </div>
            );
          })}
        </Flex>
      )}
    </Card>
  );
}

function PeopleTable({ people }: { people: StatsReport["people"] }) {
  return (
    <Card title="账号" size="small" styles={{ body: { padding: 0 } }}>
      <Table
        size="small"
        rowKey="userId"
        pagination={false}
        dataSource={people}
        scroll={{ x: "max-content" }}
        columns={[
          {
            title: "账号",
            key: "name",
            render: (_, p) => (
              <>
                {p.displayName}
                {p.disabled && <Tag style={{ marginInlineStart: 8 }}>已停用</Tag>}
              </>
            ),
          },
          { title: "活跃天数", dataIndex: "activeDays", align: "right", sorter: (a, b) => a.activeDays - b.activeDays },
          {
            title: "使用时长",
            dataIndex: "minutes",
            align: "right",
            sorter: (a, b) => a.minutes - b.minutes,
            render: (m: number) => formatMinutes(m),
          },
          {
            title: "最近活跃",
            dataIndex: "lastActive",
            align: "right",
            render: (t: string | null) =>
              t ? formatTime(t) : <Typography.Text type="secondary">90 天内没有</Typography.Text>,
          },
        ]}
      />
    </Card>
  );
}

function formatMinutes(m: number) {
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}

function formatTime(t: string) {
  return new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
