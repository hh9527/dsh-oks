# 只读方法库，输入为 {datasets,types,relations,tools,items}。
# search 定位候选，overview/card/nodes 读取事实，routes 探索连接。
# 写计划前核实粒度、允许的操作、值域含义与关系基数。
# 路径用于导航；分页与搜索上限意味着结果可能不完整，查询权限以模型声明为准。

  def pathof: split("#") | map(split("/") | map(decode_uri)) | add;
  def fact($g; $key): ($key | pathof) as $p | $g | getpath($p);
  def identity($key): ($key | pathof) as $p
    | {key:$key,type:({entities:"Entity",dimension_groups:"DimensionGroup",measure_groups:"MeasureGroup",bindings:"Binding",roles:"Role",datasets:"Dataset",types:"Ty",relations:"Relation",fields:"Field",dimensions:"Dimension",measures:"Measure",values:"Value",time_roles:"TimeRole",business_links:"BusinessLink",tools:"Tool",kinds:"FigureKind",topics:"ToolTopic"}[$p[-2]]),
       id:$p[-1],dataset:(if $p[0] == "datasets" then $p[1] else null end)};
  def typekey($type): if ($type|startswith("types/")) then $type else "types/"+($type|encode_uri) end;
  def page($skip; $take): {total:length,start:$skip,items:.[$skip:($skip+$take)],next:(if ($skip+$take)<length then ($skip+$take) else null end)};
  def edges($g):
    $g.items[] | .key as $source | fact($g;$source) | to_entries[]
    | . as $entry
    | if (["entities","dimension_groups","measure_groups","bindings","roles","datasets","types","relations","fields","dimensions","measures","values","time_roles","business_links","tools","kinds","topics"] | index($entry.key)) != null then
        if ($entry.value | type) == "array" then $entry.value[] | {source:$source,key:.,link:$entry.key}
        elif ($entry.value | type) == "object" then $entry.value | keys[] | {source:$source,key:($source + "#" + $entry.key + "/" + (. | encode_uri)),link:$entry.key}
        else empty end
      elif (["related","traversable","referenced_by"] | index($entry.key)) != null then
        $entry.value | to_entries[] | . as $group | $group.value[] | {source:$source,key:.,link:($entry.key+"."+$group.key)}
      else empty end;

  def __kindex: .items | map({key:.key,value:{label:(.names[0] // ""),doc:(.doc // "")}}) | from_entries;
  def __label($ix;$key;$fallback): if ($ix[$key].label // "") == "" then $fallback else $ix[$key].label end;
  def __window($skip;$take): . as $all | {total:length,skip:$skip,take:$take,truncated:($skip>0 or ($skip+$take)<length),next:(if ($skip+$take)<length then $skip+$take else null end),items:$all[$skip:($skip+$take)]};
  def __route_allowed($p;$e;$a):
    (($a.via|length)==0 or ($a.via|index($e.link))!=null)
    and (all($a.avoid[]; . as $s | ($e.to|contains($s))|not))
    and (($p.path|index($e.to))==null);
  def __route_walk($a):
    if ($a.frontier|length)==0 then $a + {truncated:false}
    elif ($a.found|length)>=$a.maxpaths then $a + {truncated:true}
    elif $a.depth >= $a.maxdepth then
      $a + {truncated:false,depth_capped:any($a.frontier[]; . as $p | any(($a.adj[$p.path[-1]] // [])[]; __route_allowed($p;.;$a)))}
    else
      (reduce $a.frontier[] as $p ({frontier:[],found:$a.found,candidates:$a.candidates,capped:false};
        reduce ($a.adj[$p.path[-1]] // [])[] as $e (.;
          if .candidates >= $a.budget or (.found|length)>=$a.maxpaths then .capped=true
          else .candidates+=1
            | if __route_allowed($p;$e;$a) then
                {path:($p.path+[$e.to]),links:($p.links+[$e.link])} as $next
                | if $e.to==$a.target then .found+=[$next] else .frontier+=[$next] end
              else . end
          end))) as $next
      | if $next.capped then $a + $next + {depth:($a.depth+1),truncated:true}
        else __route_walk($a + $next + {depth:($a.depth+1)}) end
    end;

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
# 参数：key, link, type, skip, take
def members($args):
  ({"skip":0,"take":10} + $args) as $args |

      . as $g
      | if fact($g;$args.key) == null then error("Unknown knowledge key: "+$args.key) else
        ($g.items | map({key:.key,value:.}) | from_entries) as $docs
        | [edges($g) | select(.source == $args.key and ($args.link == null or .link == $args.link))
           | . as $edge | identity(.key) as $id | select($args.type == null or $id.type == $args.type)
           | {key:$edge.key,type:$id.type,id:$id.id,label:($docs[$edge.key].names[0] // $id.id),link:$edge.link}]
        | unique_by([.key,.link]) | sort_by([.key,.link]) | page($args.skip;$args.take) end;

# 查找指向精确语义地址的入向引用；可按类别 link 和来源类型 type 筛选。
# 参数：key, link, type, skip, take
def references($args):
  ({"skip":0,"take":10} + $args) as $args |

      . as $g
      | if fact($g;$args.key) == null then error("Unknown knowledge key: "+$args.key)
        elif identity($args.key).type == "Ty" and fact($g;$args.key).reverse_references != true then [] | page($args.skip;$args.take) else
        ($g.items | map({key:.key,value:.}) | from_entries) as $docs
        | [edges($g) | select(.key == $args.key and ($args.link == null or .link == $args.link))
           | . as $edge | identity(.source) as $id | select($args.type == null or $id.type == $args.type)
           | {key:$edge.source,type:$id.type,id:$id.id,label:($docs[$edge.source].names[0] // $id.id),link:$edge.link}]
        | unique_by([.key,.link]) | sort_by([.key,.link]) | page($args.skip;$args.take) end;

# 配对读取事实与说明。key 可指向节点、成员或 datasets/alarm#dimensions 这样的分类分支；只展开所选分支。
# 参数：key
def read($args):
  ({} + $args) as $args |

      . as $g | fact($g;$args.key) as $facts
      | if $facts == null then error("Unknown knowledge key: "+$args.key) else
        ($args.key + (if ($args.key|contains("#")) then "/" else "#" end)) as $prefix
        | {key:$args.key,facts:$facts,items:[$g.items[] | select(.key == $args.key or (.key|startswith($prefix)))]} end;

# 列出数据集的名称、粒度和能力数量。稳定分页：skip=0、take=40（1..50）。include_source 默认为 true；显式设为 false 时过滤 source_ 开头的 ID。数量用于导航，查询权限以模型声明为准。
# 参数：skip, take, include_source
def overview($args):
  ({"skip":0,"take":40,"include_source":true} + $args) as $args |

    . as $g | __kindex as $ix
    | [$g.datasets | to_entries[] | select($args.include_source or (.key|startswith("source_")|not))
       | .key as $id | .value as $d | ("datasets/"+($id|encode_uri)) as $key
       | {id:$id,key:$key,label:__label($ix;$key;$id),grain:($d.grain // []),
          dims:(($d.dimensions // {})|length),meas:(($d.measures // {})|length),
          trs:(($d.time_roles // {})|length),rels:(($d.relations // [])|length)}]
    | sort_by(.id) | __window($args.skip;$args.take) | {total,page:{skip,take},truncated,next,datasets:.items};

# 用原始字典 id 读取数据集卡片，包含粒度、维度允许的操作、度量、时间编码、关系基数和值域。section 为 all/shape/dimensions/measures/time_roles/relations/values；默认 skip=0、take=20（1..50）、docs=false。counts 和 pages 按分段报告总量、截断与下一页偏移。值域各有 total/truncated/next；value_skip=0 控制域内值分页。所有值 ID 均保留。
# 参数：id, section, skip, take, docs, value_skip
def card($args):
  ({"section":"all","skip":0,"take":20,"docs":false,"value_skip":0} + $args) as $args |

    . as $g | __kindex as $ix | $args.id as $id | ("datasets/"+($id|encode_uri)) as $key
    | $g.datasets[$id] as $d
    | if $d==null then error("Unknown dataset id: "+$id) else
      [($d.dimensions // {}) | to_entries[] | .key as $id | .value as $v
       | ($key+"#dimensions/"+($id|encode_uri)) as $ref
       | {id:$id,key:$ref,label:__label($ix;$ref;$id),field:$v.field,fields:$v.fields,type:$v.type,
          ops:$v.ops,filterable:$v.filterable,input_kinds:$v.input_kinds,value_contract:$v.value_contract}
         + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)
         + (if $v.half_open!=null then {half_open:$v.half_open} else {} end)
         + (if $v.utc_bucket!=null then {utc_bucket:$v.utc_bucket} else {} end)] as $dims
      | [($d.measures // {}) | to_entries[] | .key as $id | .value as $v
         | ($key+"#measures/"+($id|encode_uri)) as $ref
         | {id:$id,key:$ref,label:__label($ix;$ref;$id),agg:$v.aggregate,field:$v.field}
           + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)
           + (if $v.computed!=null then {computed:$v.computed} else {} end)
           + (if $v.predicate!=null then {predicate:$v.predicate} else {} end)] as $meas
      | [($d.time_roles // {}) | to_entries[] | .key as $id | .value as $v
         | ($key+"#time_roles/"+($id|encode_uri)) as $ref
         | {id:$id,key:$ref,label:__label($ix;$ref;$id),field:$v.field,encoding:$v.encoding,
            semantics:$v.semantics,authoritative:$v.authoritative}
           + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)] as $trs
      | [($d.relations // [])[] | . as $ref | (fact($g;$ref)) as $r
         | {id:($ref|pathof|last),key:$ref,label:__label($ix;$ref;($ref|pathof|last)),
            from:$r.from_dataset,to:$r.to_dataset,cardinality:$r.cardinality}
           + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)] as $rels
      | [($d.dimensions // {})[] | .type | select(.!=null)] | unique as $types
      | [$types[] as $type | (fact($g;typekey($type))) as $t | select($t!=null)
         | [(($t.values // {})|to_entries[]) | .key as $id
            | (typekey($type)+"#values/"+($id|encode_uri)) as $ref
            | {id:$id,key:$ref,label:__label($ix;$ref;$id),wires:(.value.wires // [])}
              + (if $args.docs then {doc:($ix[$ref].doc // "")} else {} end)] as $all
         | {type:$type,key:typekey($type),canonical_order:($t.canonical_order // []),
            total:($all|length),values:($all[$args.value_skip:($args.value_skip+$args.take)]),
            truncated:($args.value_skip>0 or ($args.value_skip+$args.take)<($all|length)),
            next:(if ($args.value_skip+$args.take)<($all|length) then $args.value_skip+$args.take else null end)}] as $values
      | {id:$args.id,key:$key,label:__label($ix;$key;$args.id),doc:($ix[$key].doc // ""),grain:($d.grain // []),
         counts:{dimensions:($dims|length),measures:($meas|length),time_roles:($trs|length),relations:($rels|length),
                 value_domains:($values|length),values:($values|map(.total)|add // 0)},page:{skip:$args.skip,take:$args.take}}
      + (reduce [{name:"dimensions",items:$dims},{name:"measures",items:$meas},{name:"time_roles",items:$trs},
                 {name:"relations",items:$rels},{name:"values",items:$values}][] as $section ({};
          if $args.section=="all" or $args.section==$section.name then
            . + {($section.name):$section.items[$args.skip:($args.skip+$args.take)]}
              + {pages:((.pages // {}) + {($section.name):($section.items|__window($args.skip;$args.take)|del(.items))})}
          else . end)) end;

# 用 keys 批量读取至多 50 个语义地址。mode=docs 返回说明和提纲，facts 返回精简结构，both 同时返回两者。take=8（1..50）限制各成员列表，并返回 total/truncated。expand 指定完整展开的事实字段，docs=false 省略说明。编码地址原样使用，未知地址逐项返回错误。直接结构投影可用 select。
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

# 在 nodes 中给出恰好两个语义地址，查找有向简单路径。默认 max_depth=3（0..8）、max_paths=20（1..50）、budget=20000（1..20000 条检查边）。via 限制边类别；avoid 排除地址包含指定子串的目标。分类边保留 related.datasets 等类别名。扩展过程受限：truncated 表示路径数或搜索预算耗尽，depth_capped 表示深度限制下仍有未探索分支。受限搜索没有找到路径，不足以证明不连通。路径用于导航，写查询前仍需核实模型关系与基数。
# 参数：nodes, max_depth, max_paths, budget, via, avoid
def routes($args):
  ({"max_depth":3,"max_paths":20,"budget":20000,"via":[],"avoid":[]} + $args) as $args |

    . as $g | $args.nodes[0] as $start | $args.nodes[1] as $target
    | if fact($g;$start)==null or fact($g;$target)==null then error("Unknown route endpoint") else
      ([edges($g) | {from:.source,to:.key,link:.link}] | unique_by([.from,.to,.link]) | sort_by([.from,.to,.link])
       | group_by(.from) | map({key:.[0].from,value:map({to,link})}) | from_entries) as $adj
      | (if $start==$target then {found:[{path:[$start],links:[]}],truncated:false,depth_capped:false,candidates:0,depth:0}
         else __route_walk({adj:$adj,target:$target,maxdepth:$args.max_depth,maxpaths:$args.max_paths,budget:$args.budget,
                           via:$args.via,avoid:$args.avoid,frontier:[{path:[$start],links:[]}],found:[],candidates:0,depth:0,depth_capped:false}) end) as $result
      | {from:$start,to:$target,max_depth:$args.max_depth,path_count:($result.found|length),
         truncated:$result.truncated,depth_capped:$result.depth_capped,
         paths:($result.found|map({hops:((.path|length)-1),nodes:.path,via:.links})|sort_by([.hops,.nodes,.via])),
         search:{candidates:$result.candidates,depth_reached:$result.depth}} end;
