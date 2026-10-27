# 能力发现方法库：从模型事实发现能力、约束与候选关联，提供带事实引用的查询草案。
# 候选骨架必须交给 transform 验证并 lowering；本库不判定查询合法性或粒度安全。
# 根目录用 oks_project select=":keys" 查看，声明字段和布尔值按原样返回。

  def pathof: split("#") | map(split("/") | map(decode_uri)) | add;
  def fact($g; $key): ($key | pathof) as $p | $g | getpath($p);
  def identity($key): ($key | pathof) as $p
    | {key:$key,type:({entities:"Entity",dimension_groups:"DimensionGroup",measure_groups:"MeasureGroup",bindings:"Binding",roles:"Role",datasets:"Dataset",types:"Ty",relations:"Relation",fields:"Field",dimensions:"Dimension",measures:"Measure",values:"Value",time_roles:"TimeRole",business_links:"BusinessLink",tools:"Tool",kinds:"FigureKind",topics:"ToolTopic"}[$p[-2]]),
       id:$p[-1],dataset:(if $p[0] == "datasets" then $p[1] else null end)};
  def page($skip; $take): {total:length,start:$skip,items:.[$skip:($skip+$take)],next:(if ($skip+$take)<length then ($skip+$take) else null end)};

  def __kindex: .items | map({key:.key,value:{label:(.names[0] // ""),doc:(.doc // "")}}) | from_entries;
  def __label($ix;$key;$fallback): if ($ix[$key].label // "") == "" then $fallback else $ix[$key].label end;
  def __window($skip;$take): . as $all | {total:length,skip:$skip,take:$take,truncated:($skip>0 or ($skip+$take)<length),next:(if ($skip+$take)<length then $skip+$take else null end),items:$all[$skip:($skip+$take)]};

  # ---------- 通用小工具 ----------
  def __id($addr): ($addr | split("/") | last | decode_uri);
  def __has($arr; $v): any(($arr // [])[]; . == $v);
# ---------- 形状自检：知识图实际形状 vs 库里的硬编码类别表 ----------
# 用于发现「知识 shape 变了、库里的类别清单过时」。返回实际根分支、成员类别（含是否已知）、
# 以及各类节点的自有事实键集合。参数：无
def __known_categories:
  ["entities","dimension_groups","measure_groups","bindings","roles","datasets","types","relations",
   "fields","dimensions","measures","values","time_roles","business_links","tools","kinds","topics"];

# 库自认为已暴露的事实键（与 card/overview 的实现保持一致）；shape_audit 用它算 drifted 键。
def __surfaced:
  {"datasets":["source","row","grain","kind","scope","clock","roles","fields","time_roles","bindings",
               "dimensions","measures","business_links","types","related","relations","referenced_by"],
   "relations":["from_dataset","to_dataset","cardinality","key","guard","from_role","to_role"],
   "dimensions":["field","fields","type","ops","filterable","input_kinds","output_type","authorized",
                 "projectable","computed","canonical_order","canonical_values","half_open","utc_bucket",
                 "binding","group","scope","local"],
   "measures":["type","aggregate","anchor_field","statistic","sampling","computed","predicate","input",
               "requires","group","binding"]};

def shape_audit($args):
  (.items | map(.key)) as $keys
  | __known_categories as $known
  | __surfaced as $s
  | ([ $keys[] | split("#") as $h | ($h[0] | split("/")[0]) ] | unique) as $roots
  | ([ $keys[] | select(contains("#")) | (split("#") | last | split("/") | first) ] | group_by(.) | map({category:.[0], count:length})) as $cats
  | ([.datasets[] | keys[]] | unique) as $dk
  | ([.relations[] | keys[]] | unique) as $rk
  | ([.datasets[] | (.dimensions // {})[] | keys[]] | unique) as $dmk
  | ([.datasets[] | (.measures // {})[] | keys[]] | unique) as $mk
  | {roots:(keys),fact_roots:$roots,coverage:"observed_graph",
     member_categories:[ $cats[] | .category as $c | . + {known:(($known | index($c)) != null)} ],
     unknown_categories:[ $cats[] | .category as $c | select(($known | index($c)) == null) | .category ],
     dataset_fact_keys:$dk, relation_fact_keys:$rk,
     dimension_fact_keys:$dmk, measure_fact_keys:$mk,
     dimension_group_fact_keys:([(.dimension_groups // {})[] | keys[]] | unique),
     measure_group_fact_keys:([(.measure_groups // {})[] | keys[]] | unique),
     time_role_fact_keys:([.datasets[] | (.time_roles // {})[] | keys[]] | unique),
     type_fact_keys:([.types[] | keys[]] | unique),
     entity_fact_keys:([(.entities // {})[] | keys[]] | unique),
     drift:{unexposed:{datasets:[$dk[] as $k | select((($s.datasets)|index($k)) == null) | $k],
                       relations:[$rk[] as $k | select((($s.relations)|index($k)) == null) | $k],
                       dimensions:[$dmk[] as $k | select((($s.dimensions)|index($k)) == null) | $k],
                       measures:[$mk[] as $k | select((($s.measures)|index($k)) == null) | $k]},
            stale:{datasets:[($s.datasets)[] as $k | select(($dk|index($k)) == null) | $k],
                   relations:[($s.relations)[] as $k | select(($rk|index($k)) == null) | $k],
                   dimensions:[($s.dimensions)[] as $k | select(($dmk|index($k)) == null) | $k],
                   measures:[($s.measures)[] as $k | select(($mk|index($k)) == null) | $k]}}};

# 检索 ID、名称和说明，返回精确语义地址与精简匹配结果。
# 参数：query, type, dataset, skip, take
def search($args):
  ({"skip":0,"take":10} + $args) as $args |

      . as $g | ($args.query // "" | ascii_downcase) as $q
      | [$g.items[] | . as $item | identity(.key) as $id
         | select(($args.type == null or $id.type == $args.type) and ($args.dataset == null or $id.dataset == $args.dataset))
         | ([{field:"id",text:$id.id,weight:4}] + [$item.names[] | {field:"name",text:.,weight:3}] + [{field:"doc",text:$item.doc,weight:1}])
           | map(select(.text | ascii_downcase | contains($q))) as $hits
         | select(($hits|length)>0)
         | $id + {label:($item.names[0] // $id.id),summary:($item.doc[:160]),matched:([$hits[].field]|unique),score:([$hits[].weight]|max)}]
      | sort_by([(-.score),.key]) | page($args.skip;$args.take);

# 读取分类出向引用或自有成员。link 选择 fields/dimensions/values 等类别，type 可选，用于限制目标类型。
# 实现只读该节点自身事实（不再为单点查询扫描全图 items），因此在大图上可用。
# 参数：key, link, type, skip, take
def members($args):
  ({"skip":0,"take":10} + $args) as $args |

      . as $g | __kindex as $ix
      | if fact($g;$args.key) == null then error("Unknown knowledge key: "+$args.key) else
        (fact($g;$args.key)) as $f
        | (if ($f|type) == "object" then
             [ $f | to_entries[] | . as $e
               | if (["related","traversable","referenced_by"] | index($e.key)) != null then
                   $e.value | to_entries[] | . as $group
                   | ($e.key+"."+$group.key) as $link
                   | select($args.link==null or $args.link==$link)
                   | $group.value[] | {key:.,link:$link}
                 elif (__known_categories | index($e.key)) != null then
                   select($args.link==null or $args.link==$e.key)
                   | if ($e.value|type)=="array" then $e.value[] | {key:.,link:$e.key}
                     elif ($e.value|type)=="object" then $e.value|keys[] | {key:($args.key+"#"+$e.key+"/"+(encode_uri)),link:$e.key}
                     else empty end
                 else empty end ]
           else [] end) as $refs
        | [ $refs[] | select((.key|type)=="string") | select(fact($g;.key)!=null)
            | . as $m | (identity($m.key)) as $i
            | select($args.type == null or $i.type == $args.type)
            | {key:$m.key,type:$i.type,id:$i.id,label:__label($ix;$m.key;$i.id),link:$m.link} ]
        | unique_by([.key,.link]) | sort_by([.key,.link]) | page($args.skip;$args.take) end;

# 查找指向精确语义地址的入向引用；可按类别 link 和来源类型 type 筛选。
# 读取插件派生的 referenced_by；coverage 标记该索引的来源。
# 参数：key, link, type, skip, take
def references($args):
  ({"skip":0,"take":10} + $args) as $args |

      . as $g | __kindex as $ix
      | if fact($g;$args.key) == null then error("Unknown knowledge key: "+$args.key)
        elif identity($args.key).type == "Ty" and (fact($g;$args.key).reverse_references != true) then [] | page($args.skip;$args.take) + {coverage:"reverse_references_false"}
        else
          (fact($g;$args.key)) as $f
          | [ ((($f // {}).referenced_by // {}) | to_entries[]) | .key as $cat
              | select($args.link == null or $cat == $args.link)
              | (.value[] | {key:., link:$cat}) ]
          | [ .[] | . as $e | (identity($e.key)) as $i
              | select($args.type == null or $i.type == $args.type)
              | {key:$e.key,type:$i.type,id:$i.id,label:__label($ix;$e.key;$i.id),link:$e.link} ]
          | unique_by([.key,.link]) | sort_by([.key,.link])
          | page($args.skip;$args.take) + {coverage:"referenced_by"} end;

# 配对读取事实与说明。key 可指向节点、成员或 datasets/alarm#dimensions 这样的分类分支；只展开所选分支。
# 参数：key
def read($args):
  ({} + $args) as $args |

      . as $g | fact($g;$args.key) as $facts
      | if $facts == null then error("Unknown knowledge key: "+$args.key) else
        ($args.key + (if ($args.key|contains("#")) then "/" else "#" end)) as $prefix
        | {key:$args.key,facts:$facts,items:[$g.items[] | select(.key == $args.key or (.key|startswith($prefix)))]} end;

# 列出数据集的名称、粒度和能力数量；每行并带时间能力、桶、聚合与单位，便于先定分析层。
# 稳定分页：skip=0、take=40（1..50）。include_source 默认为 true；显式设为 false 时过滤 source_ 开头的 ID。
# 参数：skip, take, include_source
def overview($args):
  ({"skip":0,"take":40,"include_source":true} + $args) as $args |

    . as $g | __kindex as $ix
    | [$g.datasets | to_entries[] | select($args.include_source or (.key|startswith("source_")|not))
       | .key as $id | .value as $d | ("datasets/"+($id|encode_uri)) as $key
       | {id:$id,key:$key,label:__label($ix;$key;$id),grain:($d.grain // []),
          kind:($d.kind // null),clock:($d.clock // null),
          dims:(($d.dimensions // {})|length),meas:(($d.measures // {})|length),
          trs:(($d.time_roles // {})|length),rels:(($d.relations // [])|length),
          has_time:((($d.time_roles // {})|length)>0),
          time_encoding:([($d.time_roles // {})[] | .encoding] | unique),
          buckets:([($d.dimensions // {})[] | select(.utc_bucket != null) | .utc_bucket.unit] | unique),
          aggregates:([($d.measures // {})[] | .aggregate] | unique),
          sum_available:__has([($d.measures // {})[] | .aggregate]; "Sum"),
          units:([($d.measures // {})[] | ((.sampling // {}) | .unit)] | map(select(. != null)) | unique)}]
    | sort_by(.id) | __window($args.skip;$args.take) | {total,page:{skip,take},truncated,next,datasets:.items};

# 用原始字典 id 读取数据集卡片，包含粒度、维度允许的操作、度量（含统计量与物理单位）、时间编码、关系基数与遍历方向、值域。
# section 为 all/shape/roles/bindings/dimensions/measures/time_roles/relations/business_links；默认 skip=0、take=20（1..50）、docs=false。
# 参数：id, section, skip, take, docs
def card($args):
  ({"section":"all","skip":0,"take":20,"docs":false} + $args) as $args |

    . as $g | __kindex as $ix | $args.id as $id | ("datasets/"+($id|encode_uri)) as $key
    | $g.datasets[$id] as $d
    | if $d==null then error("Unknown dataset id: "+$id) else
      [($d.dimensions // {}) | to_entries[] | .key as $id | .value as $v
       | ($key+"#dimensions/"+($id|encode_uri)) as $ref
       | {id:$id,key:$ref,label:__label($ix;$ref;$id),field:$v.field,fields:$v.fields,type:$v.type,
          ops:$v.ops,filterable:$v.filterable,input_kinds:$v.input_kinds,
          output_type:($v.output_type // null),authorized:$v.authorized,
          projectable:$v.projectable,computed:$v.computed,
          canonical_order:($v.canonical_order // []),
          canonical_values:($v.canonical_values // []),
          binding:($v.binding // null),group:($v.group // null)}
         + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)
         + (if $v.half_open!=null then {half_open:$v.half_open} else {} end)
         + (if $v.utc_bucket!=null then {utc_bucket:$v.utc_bucket} else {} end)] as $dims
      | [($d.measures // {}) | to_entries[] | .key as $id | .value as $v
         | ($key+"#measures/"+($id|encode_uri)) as $ref
         | {id:$id,key:$ref,label:__label($ix;$ref;$id),type:$v.type,agg:$v.aggregate,anchor_field:($v.anchor_field // null),
            statistic:($v.statistic // null),unit:((($v.sampling // {}) | .unit) // null),
            sampling_role:((($v.sampling // {}) | .role) // null),
            input:($v.input // null),requires:($v.requires // []),
            binding:($v.binding // null),group:($v.group // null),
            computed:$v.computed,predicate:($v.predicate // null)}
           + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)] as $meas
      | [($d.time_roles // {}) | to_entries[] | .key as $id | .value as $v
         | ($key+"#time_roles/"+($id|encode_uri)) as $ref
         | {id:$id,key:$ref,label:__label($ix;$ref;$id),field:$v.field,encoding:$v.encoding,
            semantics:$v.semantics,authoritative:$v.authoritative}
           + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)] as $trs
      | [($d.relations // [])[] | . as $ref | (fact($g;$ref)) as $r
         | {id:($ref|pathof|last),key:$ref,label:__label($ix;$ref;($ref|pathof|last)),
            from:$r.from_dataset,to:$r.to_dataset,cardinality:$r.cardinality,
            key_fields:($r.key // null),guard:($r.guard // null),
            from_role:($r.from_role // null),to_role:($r.to_role // null),
            directions:["forward","reverse"]}
           + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)] as $rels
      | [($d.roles // {}) | to_entries[] | {id:.key,key:($key+"#roles/"+(.key|encode_uri)),facts:.value}] as $roles
      | [($d.bindings // {}) | to_entries[] | {id:.key,key:($key+"#bindings/"+(.key|encode_uri)),facts:.value}] as $bindings
      | [($d.business_links // {}) | to_entries[] | {id:.key,key:($key+"#business_links/"+(.key|encode_uri)),facts:.value}] as $links
      | ([($d.measures // {})[] | .aggregate] | unique) as $aggs
      | {id:$args.id,key:$key,label:__label($ix;$key;$args.id),doc:($ix[$key].doc // ""),grain:($d.grain // []),
         kind:($d.kind // null),source:($d.source // null),clock:($d.clock // null),scope:($d.scope // []),
         row:($d.row // null),business_links:((($d.business_links // {})|length)),
         aggregates:$aggs,sum_available:__has($aggs;"Sum"),
         has_time:((($d.time_roles // {})|length)>0),
         time_encoding:([($d.time_roles // {})[] | .encoding] | unique),
         buckets:([($d.dimensions // {})[] | select(.utc_bucket != null) | .utc_bucket.unit] | unique),
         units:([($d.measures // {})[] | ((.sampling // {}) | .unit)] | map(select(. != null)) | unique),
         counts:{dimensions:($dims|length),measures:($meas|length),time_roles:($trs|length),relations:($rels|length),roles:($roles|length),bindings:($bindings|length),business_links:($links|length)},
         page:{skip:$args.skip,take:$args.take}}
      + (reduce [{name:"dimensions",items:$dims},{name:"measures",items:$meas},{name:"time_roles",items:$trs},
                 {name:"relations",items:$rels},{name:"roles",items:$roles},{name:"bindings",items:$bindings},{name:"business_links",items:$links}][] as $section ({};
          if $args.section=="all" or $args.section==$section.name then
            . + {($section.name):$section.items[$args.skip:($args.skip+$args.take)]}
              + {pages:((.pages // {}) + {($section.name):($section.items|__window($args.skip;$args.take)|del(.items))})}
          else . end)) end;

# 用 keys 批量读取至多 50 个语义地址。mode=docs 返回说明和提纲，facts 返回精简结构，both 同时返回两者。
# 参数：keys, mode, take, docs, expand
def nodes($args):
  ({"mode":"docs","take":8,"docs":true,"expand":[]} + $args) as $args |

    . as $g | __kindex as $ix
    | [$args.keys[] as $key | ($key|pathof) as $path | fact($g;$key) as $f
       | if $f==null then {key:$key,error:"unknown node"} else
         {key:$key,cat:($path[-2] // $path[0]),label:__label($ix;$key;$path[-1])}
         + (if $args.docs then {doc:($ix[$key].doc // "")} else {} end)
         + (if ($f|type)!="object" then {value:$f} else
             (if $args.mode=="docs" or $args.mode=="both" then
                {outline:[$f|to_entries[]|{fact:.key,n:(if (.value|type)=="object" or (.value|type)=="array" then (.value|length) else null end)}]}
              else {} end)
             + (if $args.mode=="facts" or $args.mode=="both" then
                  {facts:[$f|to_entries[]|. as $e
                    | if ($args.expand|index($e.key))!=null then {fact:$e.key,kind:"full",value:$e.value}
                      elif ($e.value|type)=="object" then
                        ($e.value|keys|__window(0;$args.take)) as $page | {fact:$e.key,kind:"map",total:$page.total,ids:$page.items,truncated:$page.truncated}
                      elif ($e.value|type)=="array" then
                        ($e.value|__window(0;$args.take)) as $page | {fact:$e.key,kind:"list",total:$page.total,ids:$page.items,truncated:$page.truncated}
                      else {fact:$e.key,kind:"value",value:$e.value} end]}
                else {} end) end) end];

# 按子串给出「按数据集聚合」的成员版图：search 是逐条命中，这里一次看清某主题散在哪些层、什么单位、有无时间能力。
# 参数：pattern（必填，按大小写无关子串匹配）, skip, take
def metric_map($args):
  ($args.pattern // "" | ascii_downcase) as $p |
  [.datasets | to_entries[] | .key as $id | .value as $d
   | ([($d.dimensions // {}) | keys[] | select(ascii_downcase | contains($p))]) as $dims
   | ([($d.measures // {}) | to_entries[] | select(.key | ascii_downcase | contains($p))
       | ((.value.sampling // {}) | .unit // "-")]) as $units
   | select(($dims|length) > 0 or ($units|length) > 0)
   | {dataset:$id, dims:($dims|length), measures:($units|length),
      units:([$units[]] | unique), has_time:((($d.time_roles // {})|length) > 0),
      buckets:([($d.dimensions // {})[] | select(.utc_bucket != null) | .utc_bucket.unit] | unique)}]
  | sort_by(.dataset) | page(($args.skip // 0);($args.take // 20));

# 图表类型 -> 组件标签、必填映射、series 语义、开关。
def figure_kinds($args):
  [.tools.render_figure.kinds | to_entries[]
   | {kind:.key, component:.value.component, required:.value.required,
      series:.value.series, switches:.value.switches}]
  | sort_by(.kind);


# 关联候选保留完整关系路径、方向、基数、连接键和 guard，支持至多两跳。
# 深度限制与分页只限定发现范围，不表达连接完整性或查询合法性。
def __join_step($id;$r;$direction):
  {relation:$id,address:("relations/"+($id|encode_uri)),direction:$direction,
   from:(if $direction=="forward" then $r.from_dataset else $r.to_dataset end),
   to:(if $direction=="forward" then $r.to_dataset else $r.from_dataset end),
   from_role:$r.from_role,to_role:$r.to_role,cardinality:$r.cardinality,key:$r.key,guard:$r.guard};
def __join_candidates($g;$dataset;$depth):
  if $depth==0 then [] else
    ("datasets/"+($dataset|encode_uri)) as $start
    | [$g.relations | to_entries[] | .key as $id | .value as $r
       | (if $r.from_dataset==$start then __join_step($id;$r;"forward") else empty end),
         (if $r.to_dataset==$start then __join_step($id;$r;"reverse") else empty end)] as $first
    | ($first | map({path:[$start,.to],steps:[.]})) as $one
    | (if $depth<2 then [] else
        [$one[] as $p | $g.relations | to_entries[] | .key as $id | .value as $r
         | (if $r.from_dataset==$p.path[-1] then __join_step($id;$r;"forward") else empty end),
           (if $r.to_dataset==$p.path[-1] then __join_step($id;$r;"reverse") else empty end)
         | . as $step | select(($p.path|index($step.to))==null)
         | {path:($p.path+[$step.to]),steps:($p.steps+[$step])}]
       end) as $two
    | ($one+$two) | unique_by([.path,[.steps[]|[.relation,.direction]]])
    | sort_by([(.steps|length),.path,[.steps[].relation]]) end;

# cap 是能力发现器。cq 描述兴趣：target:{dataset}|{entity}, select:[{dimension}],
# measures:[{measure}], window, rank, node。skip/take 分页关联候选，join_depth=0..2。
# 仅报告事实是否找到，不检查操作授权、输入值、时间编码或关联粒度。
# 多个 Dataset 使用同一 Entity 时返回 candidates，交由调用方明确选择。
def cap($args):
  . as $g | ($args.cq // {}) as $cq | ($cq.node // "d") as $node
  | (if $cq.target.dataset!=null then
       if $g.datasets[$cq.target.dataset]!=null then [$cq.target.dataset] else [] end
     elif $cq.target.entity!=null and $g.entities[$cq.target.entity]!=null then
       [($g.entities[$cq.target.entity].roles // [])[] | (split("#")[0] | pathof) as $p
        | select($p[0]=="datasets" and $g.datasets[$p[1]]!=null) | $p[1]] | unique
     else [] end) as $candidates
  | (if ($candidates|length)==1 then $candidates[0] else null end) as $ds
  | (if $ds!=null then $g.datasets[$ds] else null end) as $d
  | (if $ds!=null then "datasets/"+($ds|encode_uri) else null end) as $address
  | [($cq.select // [])[] | .dimension as $id
     | {id:$id,address:(if $address!=null then $address+"#dimensions/"+($id|encode_uri) else null end),
        facts:(if $d!=null then $d.dimensions[$id] else null end)}] as $select
  | [($cq.measures // [])[] | .measure as $id
     | {id:$id,address:(if $address!=null then $address+"#measures/"+($id|encode_uri) else null end),
        facts:(if $d!=null then $d.measures[$id] else null end)}] as $measures
  | (if $cq.window==null then null else
       {requested:$cq.window,dimension:(if $d!=null then $d.dimensions[$cq.window.dimension] else null end)}
       | . + {roles:[($d.time_roles // {}) | to_entries[] | select(.value.field!=null and .value.field== $d.dimensions[$cq.window.dimension].field)
          | {address:($address+"#time_roles/"+(.key|encode_uri)),facts:.value}]}
     end) as $time
  | ([if $ds==null then {field:"target",reason:(if ($candidates|length)>1 then "multiple_datasets" else "not_found" end)} else empty end]
     + [$select[] | select(.facts==null) | {field:"select",id:.id,reason:"not_found"}]
     + [$measures[] | select(.facts==null) | {field:"measures",id:.id,reason:"not_found"}]
     + [if $cq.window!=null and $time.dimension==null then {field:"window.dimension",id:$cq.window.dimension,reason:"not_found"} else empty end]
     + [if $cq.rank!=null and ($d.measures[$cq.rank.measure] // null)==null then {field:"rank.measure",id:$cq.rank.measure,reason:"not_found"} else empty end]) as $unresolved
  | (if $ds==null then [] else __join_candidates($g;$ds;($args.join_depth // 1)) end) as $joins
  | {target:{requested:$cq.target,candidates:$candidates,dataset:$ds,address:$address},
     dataset:(if $d==null then null else {grain:$d.grain,kind:$d.kind,scope:$d.scope,clock:$d.clock,
       counts:{roles:(($d.roles // {})|length),bindings:(($d.bindings // {})|length)},
       available:{dimensions:(($d.dimensions // {})|keys|page(($args.skip // 0);($args.take // 20))),
                  measures:(($d.measures // {})|keys|page(($args.skip // 0);($args.take // 20))),
                  time_roles:(($d.time_roles // {})|keys|page(($args.skip // 0);($args.take // 20)))}} end),
     select:$select,measures:$measures,time:$time,unresolved:$unresolved,
     joins:($joins|page(($args.skip // 0);($args.take // 20))),
     discovery:{join_depth:($args.join_depth // 1),path_scope:"direct_relations",requires_transform:true},
     candidate_intent:(if ($unresolved|length)>0 then null else
       {op:"Graph",root:$node,nodes:[{id:$node,entity:$ds}],edges:[],
        select:[($cq.select // [])[] | {node:$node,dimension:.dimension}]}
       + (if ($measures|length)>0 then {measures:[($cq.measures // [])[] | {node:$node,measure:.measure}]} else {} end)
       + (if $cq.window!=null then {time_windows:[{node:$node,dimension:$cq.window.dimension,start:$cq.window.start,end:$cq.window.end}]} else {} end)
       + (if $cq.rank!=null then {top_by_measure:($cq.rank+{node:$node})} else {} end)
       end),
     receipts:([if $address!=null then {address:$address,fact:"dataset"} else empty end]
       + [($select+$measures)[] | select(.facts!=null) | {address:.address,fact:"capability"}]
       + [($time.roles // [])[] | {address:.address,fact:"time_role"}])};
